/** How many times the player reconnects by itself before it shows the error and the manual retry. */
export const MAX_AUTO_RECONNECTS = 5;

/** Wait before automatic reconnect number `attempt` (0, 1, 2, ...): 1 s, 2 s, 4 s, 8 s, then 15 s at most. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 15_000);
}
