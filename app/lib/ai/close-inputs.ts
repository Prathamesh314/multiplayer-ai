import type { PoolClient } from "pg";

/** Close intake under the run lock. Never replay inputs with uncertain delivery. */
export async function closeTurnInputs(tx: PoolClient, turnId: string) {
  await tx.query(`UPDATE agent_turns SET input_closed_at=COALESCE(input_closed_at,now()) WHERE id=$1`, [turnId]);
  await tx.query(`UPDATE agent_run_inputs SET status=CASE WHEN status='delivering' THEN 'unconfirmed' ELSE 'failed' END,
    error=CASE WHEN status='delivering' THEN 'The agent may have received this message. Inspect the output before sending again.' ELSE 'Execution ended before this message was delivered.' END
    WHERE turn_id=$1 AND status IN ('queued','delivering')`, [turnId]);
}
