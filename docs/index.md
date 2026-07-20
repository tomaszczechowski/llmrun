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
    - icon:
          src: /icons/no-gpu.svg
      title: No local GPU required
      details: Your laptop stays cool. Models run on the right-sized AWS GPU instance — spin it up when you need it, let it stop itself when you don't.

    - icon:
          src: /icons/cost.svg
      title: Pay for infrastructure, not tokens
      details: No per-token pricing. You pay AWS on-demand rates (~$0.80/hr) only while the instance is running. Idle auto-stop means you're rarely paying for nothing.

    - icon:
          src: /icons/security.svg
      title: Your data stays in your cloud
      details: Inference never leaves your AWS account. No third-party API receives your prompts, code, or documents — full isolation for sensitive or proprietary work.

    - icon:
          src: /icons/catalog.svg
      title: Editable model catalog
      details: llmrun.yaml maps a friendly alias to a HuggingFace repo and the GPU instance needed to serve it. Add, swap, or pin any open-source model in seconds.

    - icon:
          src: /icons/lock.svg
      title: No public IP, no SSH keys
      details: Access is entirely over AWS SSM port-forwarding. No inbound security group rules, no bastion host, no key pair to manage.

    - icon:
          src: /icons/parallel.svg
      title: Run multiple models at once
      details: Each deployment gets its own local port (8000, 8001, …). Forward all concurrently — point different tools at different models without disconnecting anything.
