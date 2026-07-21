/*
 * Network module: dedicated VPC with a public subnet and an egress-only
 * security group.
 *
 * We create our own VPC instead of relying on the account's default VPC,
 * which may be absent in non-primary regions. The instance gets a public IP
 * purely for outbound reach to SSM endpoints and HuggingFace; no inbound
 * rules are opened.
 */

resource "aws_vpc" "this" {
    cidr_block           = "10.0.0.0/16"
    enable_dns_support   = true
    enable_dns_hostnames = true

    tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}

resource "aws_internet_gateway" "this" {
    vpc_id = aws_vpc.this.id

    tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}

data "aws_availability_zones" "available" {
    state = "available"
}

# Create one subnet per AZ so we can retry across AZs when capacity is
# unavailable in the first choice (az_index selects which one to use).
resource "aws_subnet" "this" {
    count                   = min(length(data.aws_availability_zones.available.names), 3)
    vpc_id                  = aws_vpc.this.id
    cidr_block              = "10.0.${count.index + 1}.0/24"
    availability_zone       = data.aws_availability_zones.available.names[count.index]
    map_public_ip_on_launch = true

    tags = merge(var.tags, { Name = "llmrun-${var.name}-${count.index}" })
}

resource "aws_route_table" "this" {
    vpc_id = aws_vpc.this.id

    route {
        cidr_block = "0.0.0.0/0"
        gateway_id = aws_internet_gateway.this.id
    }

    tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}

resource "aws_route_table_association" "this" {
    count          = length(aws_subnet.this)
    subnet_id      = aws_subnet.this[count.index].id
    route_table_id = aws_route_table.this.id
}

resource "aws_security_group" "this" {
    name        = "llmrun-${var.name}"
    description = "llmrun ${var.name}: egress-only, access via SSM"
    vpc_id      = aws_vpc.this.id

    egress {
        description = "Allow all outbound"
        from_port   = 0
        to_port     = 0
        protocol    = "-1"
        cidr_blocks = ["0.0.0.0/0"]
    }

    tags = merge(var.tags, { Name = "llmrun-${var.name}" })
}
