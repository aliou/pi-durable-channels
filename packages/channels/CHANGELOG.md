# @aliou/pi-durable-channels

## 0.3.0

### Minor Changes

- 702c33f: Export the binding-read helpers channel packages need to build conversation-scoped tools: `ChannelsDoc`, `ChannelsState`, `Binding`, `findBinding`, and `conversationAddresses`.

## 0.2.0

### Minor Changes

- c87d00b: Support transactional conversation initialization during channel creation. `ConversationSetup.init` runs after agent configuration and before address binding in the creating commit.

## 0.1.0

### Minor Changes

- 030fc90: Initial release of durable messaging channels for pi-durable hosts. Includes the adapter contract, persistent address bindings, inbound deduplication, queue and steer policies, durable outbound retries, run events, attachments, and conversation-scoped messaging tools.
