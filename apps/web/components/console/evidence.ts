// Generated from docs/evidence/*.json (real Base Sepolia runs). Static so the deployed app needs no file access.
// Regenerate if the evidence files change.

export type Rejection = { id: string; name: string; error: string };
export type Case = { name: string; result: string; detail: string; pass: boolean };

export const EVIDENCE = {
  "bundler": {
    "generatedAt": "2026-10-17T18:41:47.014Z",
    "sessionSigner": "0x44664dDCD5A16E12302d7BC683778D074E13665C",
    "permissionId": "0x15314af3",
    "results": [
      {
        "id": "E6",
        "name": "Prompt-injection payload: transfer entire WETH balance to attacker",
        "error": "AA23 reverted 0x007e472e"
      },
      {
        "id": "E7a",
        "name": "Approve attacker as WETH spender (unlimited)",
        "error": "AA23 reverted 0x007e472e"
      },
      {
        "id": "E7b",
        "name": "Allowed router, recipient replaced with attacker",
        "error": "AA23 reverted 0x59d52e40"
      },
      {
        "id": "E7c",
        "name": "Allowed swap, amount = compiled cap + 1 wei",
        "error": "AA23 reverted 0x59d52e40"
      },
      {
        "id": "E7f",
        "name": "Buy side: recipient replaced with attacker",
        "error": "AA23 reverted 0x59d52e40"
      },
      {
        "id": "E7g",
        "name": "Buy side: amountInMaximum = USDC cap + 1",
        "error": "AA23 reverted 0x59d52e40"
      },
      {
        "id": "E7h",
        "name": "Transfer USDC to attacker",
        "error": "AA23 reverted 0x007e472e"
      },
      {
        "id": "E7i",
        "name": "Approve attacker as USDC spender (unlimited)",
        "error": "AA23 reverted 0x007e472e"
      }
    ]
  },
  "revocation": {
    "generatedAt": "2026-10-14T16:29:24.750Z",
    "permissionId": "0xb4a1c62d",
    "results": [
      {
        "id": "E7d",
        "name": "After revocation: previously-ALLOWED swap at half cap",
        "error": "AA23 reverted 0x"
      },
      {
        "id": "E7e",
        "name": "After revocation: transfer WETH to attacker",
        "error": "AA23 reverted 0x"
      }
    ]
  },
  "isolation": [
    {
      "name": "Install WETH permission + sell WETH within its cap",
      "result": "EXECUTED_SUCCESS",
      "detail": "success=true",
      "pass": true
    },
    {
      "name": "Install B permission (second validator) + sell B within its cap (10x the WETH cap)",
      "result": "EXECUTION_FAILED",
      "detail": "success=false",
      "pass": true
    },
    {
      "name": "WETH key still works after B was installed: buy WETH within its USDC cap",
      "result": "EXECUTED_SUCCESS",
      "detail": "success=true",
      "pass": true
    },
    {
      "name": "WETH key: sell above WETH cap",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "WETH key cannot trade asset B (sell B)",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "WETH key cannot trade asset B (buy B)",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "B key cannot trade WETH (sell WETH within WETH cap)",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "B key: sell above B cap",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "B key: buy B above its USDC cap (below WETH's)",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "B key: buy B within its USDC cap",
      "result": "EXECUTION_FAILED",
      "detail": "success=false",
      "pass": true
    },
    {
      "name": "B key: recipient = attacker",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "B key: direct B→WETH (bypassing the USDC hub)",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x59d52e40)",
      "pass": true
    },
    {
      "name": "WETH key: permitted sell batched with USDC.transfer to attacker",
      "result": "VALIDATION_REJECTED",
      "detail": "FailedOpWithRevert(0, AA23 reverted, 0x007e472e)",
      "pass": true
    }
  ],
  "sharedPolicy": "A single call policy with two same-selector entries (one per asset) is refused at install with \"duplicate permissionHash\" — so Guardian installs one isolated session key per asset.",
  "e8": {
    "userOpHash": "0x509287eddc5aea08255b8045de157685e5371ed4d317e6a139949f194fcfb227",
    "transactionHash": "0x84e27e2a5e9552620bec2b9658373524bdb0464a4854ce64b3e12c9096eae6e4",
    "block": "48113696",
    "revertReason": "Too little received",
    "classification": "EXECUTION_FAILED (authorization passed)",
    "explorer": "https://sepolia.basescan.org/tx/0x84e27e2a5e9552620bec2b9658373524bdb0464a4854ce64b3e12c9096eae6e4"
  }
} as const;
