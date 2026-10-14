import { decodeErrorResult, decodeEventLog, encodeFunctionData, erc20Abi, type Address, type Hex, type PublicClient } from "viem";
import { simulateBlocks } from "viem/actions";
import { entryPoint07Abi, entryPoint07Address, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";

export type Step =
  | { kind: "userop"; label: string; op: UserOperation<"0.7"> }
  | { kind: "call"; label: string; to: Address; data: Hex };

export type StepOutcome = {
  label: string;
  /** VALIDATION_REJECTED: the EntryPoint refused the op (authorization failure).
   *  EXECUTION_FAILED: included, but the account's call reverted (not an authorization result). */
  result: "VALIDATION_REJECTED" | "EXECUTED_SUCCESS" | "EXECUTION_FAILED" | "CALL_OK" | "CALL_FAILED";
  detail: string;
  returnData?: Hex;
  tokenTransfers?: { token: Address; from: Address; to: Address; value: bigint }[];
};

export interface SimulationBlock { time?: number; steps: Step[] }

/**
 * Executes UserOperations through EntryPoint.handleOps inside eth_simulateV1 (no broadcast),
 * carrying state across steps and blocks.
 */
export async function simulateHandleOps(client: PublicClient, p: {
  beneficiary: Address; blocks: SimulationBlock[]; stateOverrides?: unknown[]; watchTokens?: Address[];
}): Promise<StepOutcome[]> {
  const blocks = p.blocks.map((b, i) => ({
    ...(i === 0 && p.stateOverrides ? { stateOverrides: p.stateOverrides } : {}),
    ...(b.time ? { blockOverrides: { time: BigInt(b.time) } } : {}),
    calls: b.steps.map((s) => s.kind === "userop"
      ? { account: p.beneficiary, to: entryPoint07Address, gas: 20_000_000n,
          data: encodeFunctionData({ abi: entryPoint07Abi, functionName: "handleOps", args: [[toPackedUserOperation(s.op)], p.beneficiary] }) }
      : { account: p.beneficiary, to: s.to, data: s.data }),
  }));
  const res = await simulateBlocks(client, { blocks, validation: false } as never);
  const steps = p.blocks.flatMap((b) => b.steps);
  const calls = res.flatMap((b) => b.calls);
  const watch = new Set((p.watchTokens ?? []).map((t) => t.toLowerCase()));

  return calls.map((c, i) => {
    const step = steps[i]!;
    if (step.kind === "call") return c.status === "success"
      ? { label: step.label, result: "CALL_OK", detail: "ok", returnData: c.data }
      : { label: step.label, result: "CALL_FAILED", detail: c.error?.message.split("\n")[0] ?? "reverted" };
    if (c.status === "failure") {
      let detail = c.error?.message.split("\n")[0] ?? "reverted";
      try { const d = decodeErrorResult({ abi: entryPoint07Abi, data: c.data }); detail = `${d.errorName}(${d.args?.map(String).join(", ")})`; } catch {}
      return { label: step.label, result: /FailedOp/.test(detail) ? "VALIDATION_REJECTED" : "CALL_FAILED", detail };
    }
    let ok: boolean | undefined, reason = "";
    const tokenTransfers: NonNullable<StepOutcome["tokenTransfers"]> = [];
    for (const l of c.logs ?? []) {
      try { const e = decodeEventLog({ abi: entryPoint07Abi, data: l.data, topics: l.topics });
        if (e.eventName === "UserOperationEvent") ok = e.args.success;
        if (e.eventName === "UserOperationRevertReason") reason = e.args.revertReason; } catch {}
      if (watch.has(l.address.toLowerCase())) {
        try { const t = decodeEventLog({ abi: erc20Abi, data: l.data, topics: l.topics });
          if (t.eventName === "Transfer") tokenTransfers.push({ token: l.address, from: t.args.from, to: t.args.to, value: t.args.value }); } catch {}
      }
    }
    return ok
      ? { label: step.label, result: "EXECUTED_SUCCESS", detail: "UserOperationEvent success=true", tokenTransfers }
      : { label: step.label, result: "EXECUTION_FAILED", detail: `UserOperationEvent success=false ${reason}`.trim(), tokenTransfers };
  });
}
