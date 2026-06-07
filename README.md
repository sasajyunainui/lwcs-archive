# LWCS Archive

SillyTavern server plugin for LWCS cold archive JSON storage.

Install from a Git URL:

```bash
cd SillyTavern
node plugins.js install <lwcs-archive-git-url>
```

Then enable server plugins in `config.yaml` and restart SillyTavern:

```yaml
enableServerPlugins: true
```

The default archive root is `data/<user>/lwcs_archive`.
