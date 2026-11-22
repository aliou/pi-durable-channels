# Channel terms

## Durable extension

A registration installed in a pi-durable Harness registry, such as `channels.extension` or `channels.tools`. It is not a Pi coding-agent extension loaded by the interactive agent.

## Channel and adapter

A channel is a host-assigned name, such as `slack`. An adapter connects that channel to a platform and owns its transport, authentication, and address format; the channel name is not an agent persona.

## Outbound representation and format

An outbound representation is platform-specific JSON content carried alongside required fallback text. Its format key identifies the representation contract an adapter can consume, not the host-assigned channel name; adapters that do not consume the format deliver the fallback text.

## Address and conversation

An address identifies a destination within a channel, such as a Slack thread. A conversation holds durable agent state; several addresses, including aliases, can bind to the same conversation, but an address belongs to only one conversation at a time.

## Conversation address and alias

A conversation address is the same-channel fallback used to find a conversation when an inbound address has no exact binding. An alias is an address bound through that fallback; its binding records the conversation address in `via`, while its reply destination, address data, and admission cursor remain independent.

## Admission and delivery

Admission means the inbound message has been stored and has a submission receipt. It does not mean the agent has answered or the platform has accepted a reply. An admission cursor is an opaque per-address string committed with successful admission; duplicates, failed admissions, history reads, and deliveries without a cursor do not advance it.

## Source history

Source history is formatted content an adapter reads around opaque range cursors for an address. It is read-only and bounded, and it is distinct from durable conversation entries and the admission cursor.

## Durable send and run event

A durable send carries an outbound reply or notification and can repeat after a crash. A run event describes activity for presentation; it is best effort and is not a durable delivery guarantee.

## Address data and reply context

Address data is stored with an address and remains until replaced. Reply context belongs to one inbound message and accompanies its reply and run events, not every later message to that address.
