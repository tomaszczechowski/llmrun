- use pnpm
- License is: Apache
- add gitignore files

# Formatting

- use 4 spaces formatting
- use prettier

```json
{
    "tabWidth": 4,
    "useTabs": false,
    "semi": true,
    "singleQuote": false,
    "trailingComma": "es5",
    "printWidth": 120
}
```

- use eslint

# Terraform

- use tfvars directory
- use modules directory with details of each module
- use main directory for models initialization.

example:

```tf
/* ECS */
ecs_tasks_spec = {
  backend = {
    task_cpu           = 256
    task_memory        = 512
    task_desired_count = 1
  }

  frontend = {
    task_cpu           = 1024
    task_memory        = 2048
    task_desired_count = 1
  }
}
```
