# Channel terms

## Durable extension

A registration installed in a pi-durable Harness registry, such as `channels.extension` or `channels.tools`. It is not a Pi coding-agent extension loaded by the interactive agent.

## Channel and adapter

A channel is a host-assigned name, such as `slack`. An adapter connects that channel to a platform and owns its transport, authentication, and address format; the channel name is not an agent persona.

## Address and conversation

An address identifies a destination within a channel, such as a Slack thread. A conversation holds durable agent state; several addresses, including aliases, can bind to the same conversation, but an address belongs to only one conversation at a time.

## Admission and delivery

Admission means the inbound message has been stored and has a submission receipt. It does not mean the agent has answered or the platform has accepted a reply.

## Durable send and run event

A durable send carries an outbound reply or notification and can repeat after a crash. A run event describes activity for presentation; it is best effort and is not a durable delivery guarantee.

## Address data and reply context

Address data is stored with an address and remains until replaced. Reply context belongs to one inbound message and accompanies its reply and run events, not every later message to that address.
