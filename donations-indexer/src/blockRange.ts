/**
 * Bounded Portal range resolution for the scheduled donations indexer.
 *
 * Historical blocks always come from the selected Portal Dataset Endpoint.
 * JSON-RPC is used only to read the current chain head, then the finality
 * depth determines an inclusive bounded Portal range.
 */

export interface ResolveToBlockArgs {
  readonly startBlock: number
  readonly head: number
  readonly finalityConfirmation: number
}

export const resolveToBlock = ({
  startBlock,
  head,
  finalityConfirmation,
}: ResolveToBlockArgs): number | undefined => {
  if (!Number.isInteger(head) || head < 0) {
    throw new Error(`resolveToBlock: head must be a non-negative integer, got ${head}`)
  }
  if (!Number.isInteger(startBlock) || startBlock < 0) {
    throw new Error(
      `resolveToBlock: startBlock must be a non-negative integer, got ${startBlock}`,
    )
  }
  if (!Number.isInteger(finalityConfirmation) || finalityConfirmation < 0) {
    throw new Error(
      `resolveToBlock: finalityConfirmation must be a non-negative integer, got ${finalityConfirmation}`,
    )
  }

  const finalizedHead = head - finalityConfirmation
  return finalizedHead < startBlock ? undefined : finalizedHead
}
