---
layout: home

hero:
    name: "llmrun"
    text: "Local LLMs on AWS GPU"
    tagline: Work locally with deployed open-models in your cloud.
    actions:
        - theme: brand
          text: Get Started
          link: /guide/getting-started

features:
    - icon: 📋
      title: Editable model catalog
      details: llmrun.yaml maps a friendly alias to a HuggingFace repo and the GPU instance needed to serve it. Add your own models in seconds.

    - icon: 💸
      title: Cost preview before provisioning
      details: Every llmrun up shows the instance cost per hour and per day before asking for confirmation. No surprise bills.

    - icon: 🔒
      title: No public IP, no SSH keys
      details: Access is entirely over AWS SSM port-forwarding. No inbound security group rules, no bastion host, no key pair to manage.

    - icon: ⏹️
      title: Idle auto-stop
      details: A systemd timer on the instance polls vLLM metrics and shuts down after configurable inactivity — EBS and model cache are preserved for a fast restart.

    - icon: 🩺
      title: Doctor preflight
      details: llmrun doctor checks Terraform, AWS CLI, SSM plugin, credentials, and GPU vCPU quota. Runs automatically before up and start.

    - icon: 🔀
      title: Run multiple models at once
      details: Each deployment gets its own local port (8000, 8001, …). Forward all concurrently with llmrun connect --all.
---
