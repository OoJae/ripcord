import { describe, expect, it, vi } from "vitest";
import {
  HttpKeeperHubClient,
  KeeperHubHttpError,
  MockKeeperHubClient,
  RunTimeoutError,
  waitForRun,
} from "../../src/executor/keeperhub.js";
import type { DefensePayload } from "../../src/types.js";
import { fixedClock, TEST_ADDRESS } from "../helpers/fakes.js";

const PAYLOAD: DefensePayload = {
  decisionId: "01J9TESTDECISION0000000000",
  chain: "base-sepolia",
  action: "repay",
  assetSymbol: "USDC",
  assetAddress: "0xba50Cd2A20f6DA35D788639E581bca8d0B5d4D5f",
  amountBaseUnits: "5000000",
  amountUsd: 5,
  minHfAfter: 1.6,
  monitoredAddress: TEST_ADDRESS,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("HttpKeeperHubClient.triggerDefense", () => {
  it("POSTs the exact payload with Bearer auth and parses executionId", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ executionId: "exec_123", status: "running" }),
    );
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://app.keeperhub.com/hook/wf2",
      apiKey: "kh_secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const res = await client.triggerDefense(PAYLOAD);
    expect(res.runId).toBe("exec_123");

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://app.keeperhub.com/hook/wf2");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer kh_secret");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");

    // VERIFIED 2026-08-01: /execute requires the {"input": {...}} envelope. A
    // bare body still returns 200 but its fields never reach the trigger node,
    // so every {{@trigger-1:Trigger.<field>}} reference silently fails to
    // resolve. The envelope is load-bearing, not cosmetic.
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(Object.keys(sent)).toEqual(["input"]);

    // Inside the envelope: exactly the DefensePayload keys — nothing extra, and
    // the only address present is the one resolved from the config allowlist.
    const input = sent.input as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(Object.keys(PAYLOAD).sort());
    expect(input.assetAddress).toBe(PAYLOAD.assetAddress);
  });

  it("parses a run id from the documented { data: … } envelope", async () => {
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      fetchImpl: (async () => jsonResponse({ data: { id: "exec_from_envelope" } })) as typeof fetch,
    });
    expect((await client.triggerDefense(PAYLOAD)).runId).toBe("exec_from_envelope");
  });

  it("throws KeeperHubHttpError on a non-2xx response", async () => {
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      fetchImpl: (async () => jsonResponse({ error: "nope" }, 502)) as typeof fetch,
    });
    await expect(client.triggerDefense(PAYLOAD)).rejects.toMatchObject({
      name: "KeeperHubHttpError",
      status: 502,
    });
  });

  it("FAILS CLOSED on a 2xx with no run id rather than reporting a phantom trigger", async () => {
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      fetchImpl: (async () => jsonResponse({ ok: true })) as typeof fetch,
    });
    await expect(client.triggerDefense(PAYLOAD)).rejects.toBeInstanceOf(KeeperHubHttpError);
  });
});

describe("HttpKeeperHubClient.getRun", () => {
  it("maps the documented execution shape to RunStatus and keeps the raw body", async () => {
    const body = {
      data: {
        id: "exec_1",
        status: "success",
        transactionHashes: [{ hash: "0xabc", chainId: 84532, network: "base-sepolia" }],
      },
    };
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return jsonResponse(body);
    }) as unknown as typeof fetch;
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      apiBaseUrl: "https://api.test/api",
      fetchImpl,
    });

    const run = await client.getRun("exec_1");
    expect(run.state).toBe("success");
    expect(run.txHash).toBe("0xabc");
    expect(run.txHashes?.[0]?.chainId).toBe(84532);
    expect(run.raw).toEqual(body);
    expect(urls[0]).toBe("https://api.test/api/workflows/executions/exec_1/status");
  });

  it("treats an unknown status as NON-terminal and preserves it in raw", async () => {
    const warn = vi.fn();
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      fetchImpl: (async () => jsonResponse({ status: "quantum-superposition" })) as typeof fetch,
      logger: { info: vi.fn(), warn, error: vi.fn() },
    });
    const run = await client.getRun("exec_9");
    expect(run.state).toBe("running"); // never invents a terminal outcome
    expect(run.raw).toEqual({ status: "quantum-superposition" });
    expect(warn).toHaveBeenCalled();
  });

  it("surfaces an error state instead of swallowing it", async () => {
    const client = new HttpKeeperHubClient({
      triggerUrl: "https://x/hook",
      fetchImpl: (async () =>
        jsonResponse({ status: "error", error: "execution reverted" })) as typeof fetch,
    });
    const run = await client.getRun("exec_err");
    expect(run.state).toBe("error");
    expect(run.error).toBe("execution reverted");
  });
});

describe("waitForRun", () => {
  it("polls to a terminal state with exponential backoff", async () => {
    const mock = new MockKeeperHubClient({ script: ["pending", "running", "success"] });
    const { runId } = await mock.triggerDefense(PAYLOAD);
    const delays: number[] = [];

    const run = await waitForRun(mock, runId, {
      sleep: async (ms) => {
        delays.push(ms);
      },
      clock: fixedClock().now,
    });

    expect(run.state).toBe("success");
    expect(delays).toEqual([2000, 3000]); // 2s then 2s × 1.5
  });

  it("throws RunTimeoutError instead of polling forever", async () => {
    const mock = new MockKeeperHubClient({ neverTerminal: true });
    const { runId } = await mock.triggerDefense(PAYLOAD);
    const clock = fixedClock();

    await expect(
      waitForRun(mock, runId, {
        timeoutMs: 10_000,
        sleep: async (ms) => clock.advance(ms),
        clock: clock.now,
      }),
    ).rejects.toBeInstanceOf(RunTimeoutError);
  });
});

describe("MockKeeperHubClient", () => {
  it("records every attempted payload, including one whose trigger failed", async () => {
    const mock = new MockKeeperHubClient({ failOnce: true });
    await expect(mock.triggerDefense(PAYLOAD)).rejects.toBeInstanceOf(KeeperHubHttpError);
    const ok = await mock.triggerDefense(PAYLOAD);
    expect(ok.runId).toMatch(/^mockrun_/);
    expect(mock.receivedPayloads).toHaveLength(2);
  });

  it("produces a deterministic tx hash for a given decisionId", async () => {
    const a = new MockKeeperHubClient({ script: ["success"] });
    const b = new MockKeeperHubClient({ script: ["success"] });
    const ra = await a.triggerDefense(PAYLOAD);
    const rb = await b.triggerDefense(PAYLOAD);
    expect((await a.getRun(ra.runId)).txHash).toBe((await b.getRun(rb.runId)).txHash);
  });

  it("fails closed on an unknown run id", async () => {
    await expect(new MockKeeperHubClient().getRun("mockrun_nope")).rejects.toBeInstanceOf(
      KeeperHubHttpError,
    );
  });
});
