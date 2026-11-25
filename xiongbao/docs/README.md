# XiongBao Work docs

Start with the root [README](../README.md), then use these references:

- [Architecture](architecture.md): services, ports, browser governance, computers, components, plugins, knowledge, and security boundaries.
- [Configuration](configuration.md): environment variables and tenant package YAML.
- [Personal edition](personal-edition.md): XiongBao Work for one person, with no sign-in and no Admin.
- [Development](development.md): local setup, migrations, ports, and quality checks.
- [Coworkers](coworkers.md): durable Bot profiles, channels, visibility, deletion, and external AG-UI registration.
- [Routines](routines.md): standing instructions a Bot runs on a schedule, the worker that fires them, and who they run as.
- [招聘与组群](staffing.md): 在对话里让小管家起草新员工、员工改动和群聊，确认卡片上的各项，谁能确认，以及限制。
- [招入外部员工](external-agents.md): 把电脑上的 Codex、Claude Code 招成员工：前提、招入步骤、手机批准、离线排队和常见问题。
- [Automatic Learning](automatic-learning.md): which Bots contribute conversations to a Learning container, and receive its published skills.
- [Public-web research](web-research.md): search and page reading through Parallel, Exa or Firecrawl.
- Plugins, one connector per page — what an administrator registers, what each person consents to, and what the failures mean:
  - [Composio](plugins/composio.md): the broker, and so the one page here that is a catalogue of apps rather than a single connector.
  - [Google Drive](plugins/google-drive.md)
  - [Notion](plugins/notion.md)
- [Deployment](deployment.md): the container, what is in the image, minimum sizes, and the platform notes.
- [Kubernetes](../charts/xiongbao/README.md): the Helm chart, what a cluster needs before it, and the values that differ per cloud.
- [Releasing](releasing.md): how a release is proposed, reviewed and published.

Do not include credential values, customer data, transcripts, or local-only notes in public docs.
