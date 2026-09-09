import {
    EC2Client,
    DescribeInstancesCommand,
    DescribeAvailabilityZonesCommand,
    DescribeInstanceTypeOfferingsCommand,
    StartInstancesCommand,
    StopInstancesCommand,
    type InstanceStateName,
} from "@aws-sdk/client-ec2";
import { ServiceQuotasClient, GetServiceQuotaCommand } from "@aws-sdk/client-service-quotas";
import { SSMClient, DescribeInstanceInformationCommand } from "@aws-sdk/client-ssm";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import type { AwsSelection } from "./config.js";
import { LlmrunError } from "./errors.js";

/**
 * Thin wrappers around the AWS SDK v3. Credentials are resolved through the
 * standard Node provider chain, honouring the selected profile. SSM session
 * operations are handled separately via the `aws` CLI (see ssm.ts).
 */

function credentials(sel: AwsSelection) {
    return fromNodeProviderChain(sel.profile ? { profile: sel.profile } : {});
}

export function ec2Client(sel: AwsSelection): EC2Client {
    return new EC2Client({ region: sel.region, credentials: credentials(sel) });
}

export function quotasClient(sel: AwsSelection): ServiceQuotasClient {
    return new ServiceQuotasClient({ region: sel.region, credentials: credentials(sel) });
}

export function ssmClient(sel: AwsSelection): SSMClient {
    return new SSMClient({ region: sel.region, credentials: credentials(sel) });
}

/** Whether the SSM agent on an instance has registered and is reachable. */
export async function isSsmOnline(sel: AwsSelection, instanceId: string): Promise<boolean> {
    const res = await ssmClient(sel).send(
        new DescribeInstanceInformationCommand({
            Filters: [{ Key: "InstanceIds", Values: [instanceId] }],
        })
    );

    return res.InstanceInformationList?.[0]?.PingStatus === "Online";
}

/**
 * Wait until the instance is registered with SSM (PingStatus=Online). This must
 * happen before port-forwarding/shell/logs work — the agent takes a short while
 * to register after the instance reaches "running".
 */
export async function waitForSsmOnline(
    sel: AwsSelection,
    instanceId: string,
    timeoutMs = 300_000,
    intervalMs = 5_000
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        try {
            if (await isSsmOnline(sel, instanceId)) return true;
        } catch {
            // Transient API error — keep polling.
        }
        await new Promise((r) => setTimeout(r, intervalMs));
    }

    return false;
}

export interface InstanceInfo {
    instanceId: string;
    state: InstanceStateName;
    instanceType?: string;
    privateIp?: string;
    publicIp?: string;
}

export async function describeInstance(sel: AwsSelection, instanceId: string): Promise<InstanceInfo | undefined> {
    const client = ec2Client(sel);
    const res = await client.send(new DescribeInstancesCommand({ InstanceIds: [instanceId] }));
    const inst = res.Reservations?.[0]?.Instances?.[0];

    if (!inst?.InstanceId) return undefined;

    return {
        instanceId: inst.InstanceId,
        state: (inst.State?.Name ?? "pending") as InstanceStateName,
        instanceType: inst.InstanceType,
        privateIp: inst.PrivateIpAddress,
        publicIp: inst.PublicIpAddress,
    };
}

export async function startInstance(sel: AwsSelection, instanceId: string): Promise<void> {
    await ec2Client(sel).send(new StartInstancesCommand({ InstanceIds: [instanceId] }));
}

export async function stopInstance(sel: AwsSelection, instanceId: string): Promise<void> {
    await ec2Client(sel).send(new StopInstancesCommand({ InstanceIds: [instanceId] }));
}

/** Poll until the instance reaches one of the target states, or time out. */
export async function waitForInstanceState(
    sel: AwsSelection,
    instanceId: string,
    targets: InstanceStateName[],
    timeoutMs = 300_000,
    intervalMs = 5_000
): Promise<InstanceStateName> {
    const deadline = Date.now() + timeoutMs;
    // Note: Date.now() is used only for a wall-clock timeout here.
    while (Date.now() < deadline) {
        const info = await describeInstance(sel, instanceId);

        if (info && targets.includes(info.state)) return info.state;
        await new Promise((r) => setTimeout(r, intervalMs));
    }
    throw new LlmrunError(`Timed out waiting for instance ${instanceId} to reach: ${targets.join(", ")}.`);
}

/**
 * Service Quota codes for On-Demand vCPU limits, keyed by instance family prefix.
 * These are the standard, region-independent quota codes for EC2.
 */
const GPU_QUOTA_CODES: Record<string, { code: string; label: string }> = {
    g: { code: "L-DB2E81BA", label: "Running On-Demand G and VT instances" },
    vt: { code: "L-DB2E81BA", label: "Running On-Demand G and VT instances" },
    p: { code: "L-417A185B", label: "Running On-Demand P instances" },
};

export interface QuotaInfo {
    /** vCPUs currently allowed by the account quota. */
    limit: number;
    quotaCode: string;
    quotaLabel: string;
    /** Family prefix used for the lookup (e.g. "g", "p"). */
    family: string;
}

/** Family prefix of an instance type, e.g. "g6.xlarge" → "g", "p4d.24xlarge" → "p". */
export function instanceFamilyPrefix(instanceType: string): string {
    const m = instanceType.match(/^([a-z]+)/);

    return m?.[1] ?? "";
}

/**
 * Look up the On-Demand vCPU quota that governs the given GPU instance type.
 * Returns undefined for families we don't have a mapping for (e.g. CPU instances).
 */
export async function getGpuVcpuQuota(sel: AwsSelection, instanceType: string): Promise<QuotaInfo | undefined> {
    const family = instanceFamilyPrefix(instanceType);
    // Match the longest known prefix (so "vt" wins over "v" — though only "g"/"p"/"vt" exist here).
    const key = ["vt", "g", "p"].find((k) => family.startsWith(k));

    if (!key) return undefined;
    const mapping = GPU_QUOTA_CODES[key]!;
    const res = await quotasClient(sel).send(
        new GetServiceQuotaCommand({ ServiceCode: "ec2", QuotaCode: mapping.code })
    );

    return {
        limit: res.Quota?.Value ?? 0,
        quotaCode: mapping.code,
        quotaLabel: mapping.label,
        family: key,
    };
}

/** Deep link to the Service Quotas console page for requesting an increase. */
export function quotaConsoleUrl(region: string | undefined, quotaCode: string): string {
    const r = region ?? "us-east-1";

    return `https://${r}.console.aws.amazon.com/servicequotas/home/services/ec2/quotas/${quotaCode}`;
}

/**
 * Returns the AZs (sorted alphabetically, max 3) in which the given instance
 * type is offered. Uses DescribeInstanceTypeOfferings — this tells you WHERE
 * the type exists, but not whether capacity is available right now. It's a
 * cheap pre-flight that eliminates AZs that never have the instance.
 *
 * An empty (but valid) response is returned as-is: it means the type is not
 * offered in this region, and falling back to all AZs would only cause a
 * guaranteed "unsupported configuration" failure later. The AZ-list fallback
 * is used only when DescribeInstanceTypeOfferings itself errors (transient
 * API failure, where "empty" would be a false negative).
 */
export async function getInstanceTypeAzs(sel: AwsSelection, instanceType: string): Promise<string[]> {
    const client = ec2Client(sel);

    try {
        const res = await client.send(
            new DescribeInstanceTypeOfferingsCommand({
                LocationType: "availability-zone",
                Filters: [{ Name: "instance-type", Values: [instanceType] }],
            })
        );

        return (res.InstanceTypeOfferings ?? [])
            .map((o) => o.Location ?? "")
            .filter(Boolean)
            .sort()
            .slice(0, 3);
    } catch {
        // Offerings API failed (not "not offered") — fall back to all
        // available AZs in the region (sorted, max 3).
        try {
            const res = await client.send(
                new DescribeAvailabilityZonesCommand({ Filters: [{ Name: "state", Values: ["available"] }] })
            );

            return (res.AvailabilityZones ?? [])
                .map((z) => z.ZoneName ?? "")
                .filter(Boolean)
                .sort()
                .slice(0, 3);
        } catch {
            return [];
        }
    }
}
