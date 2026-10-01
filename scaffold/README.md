# Consumer scaffold

Copy this directory into a new consuming project, install the provider archive and `./consumer-model`, then use your own PNG and WAV assets. The example graph and IDs are inert fixtures. Execution is disabled, `fixtureOnly` is true, and no reviewed billing binding is supplied.

The Model Surface reads its exact ports from `consumer-model/descriptor.json`. It accepts one required value for each port: media as authored Blob references and scalars as literal values. The example exposes image, audio, prompt, seed, audioStart and duration; node IDs, class constraints and field mappings stay in the descriptor. Change that descriptor and graph for another workflow, copy them into the selected Profile dataRoot, and obtain a fresh owner review before enabling real execution.

No server node defaults or scalar limits are inferred by the scaffold. Declare reviewed constraints in the descriptor. Changing Model identity requires updating package metadata, descriptor capability/portTable and the Source/Profile bindings together. The `Workflow` output follows the descriptor's image/video result type.

See the provider's [Russian reuse guide](../docs/REUSE_RU.md) and [workflow management](../docs/workflow-management.md). Hypit 0.2.16 supplies public SDK imports when loading the installed Model; no private SDK source or test loader is part of this scaffold.
