import { describe, expect, test } from "bun:test";
import { createTrajectoryConnect } from "../src/recorder/trajectory-connect";

/*
 * The Recorder's capture pass as OpenBot answers it (recorder/trajectory-connect.ts): the gate in front,
 * then the person, then Intelligence, each answered in the runtime's own contract.
 */

const ID = "11111111-2222-4333-8444-555555555555";
const settings = { apiUrl: "http://intelligence.test", apiKey: "k" };
const request = () =>
  new Request(`http://openbot.test/api/copilotkit/trajectory/${ID}/connect`, {
    method: "POST",
  });

function connect(overrides: {
  gate?: () => Promise<void>;
  identifyUser?: () => Promise<{ id: string; name: string }>;
  join?: (params: unknown) => Promise<unknown>;
}) {
  const joined: unknown[] = [];
  const answer = createTrajectoryConnect({
    intelligence: settings,
    gate: (overrides.gate ?? (async () => {})) as never,
    selectLearningContainers: async () => null,
    identifyUser:
      overrides.identifyUser ?? (async () => ({ id: "person", name: "P" })),
    client: {
      ɵconnectTrajectory: (async (params: unknown) => {
        joined.push(params);
        return overrides.join
          ? overrides.join(params)
          : {
              joinToken: "t",
              realtime: {
                clientUrl: "ws://g/client",
                topic: `trajectory:${ID}`,
              },
            };
      }) as never,
    },
  });
  return { answer, joined };
}

describe("the capture pass OpenBot answers itself", () => {
  test("a refusal the gate wrote is the answer, and Intelligence is not asked", async () => {
    const refusal = Response.json(
      { code: "IDENTITY_REQUIRED" },
      { status: 401 },
    );
    const { answer, joined } = connect({
      gate: async () => {
        throw refusal;
      },
    });

    const response = await answer(request(), ID);

    expect(response).toBe(refusal);
    expect(joined).toEqual([]);
  });

  test("a passed gate joins the trajectory as the person, and the grant is not cached", async () => {
    const { answer, joined } = connect({});

    const response = await answer(request(), ID);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      joinToken: "t",
      realtime: { clientUrl: "ws://g/client", topic: `trajectory:${ID}` },
    });
    expect(joined).toMatchObject([
      { trajectoryId: ID, user: { id: "person", name: "P" } },
    ]);
  });

  test("nobody to join as is the runtime's IDENTITY_REQUIRED", async () => {
    const { answer, joined } = connect({
      identifyUser: async () => {
        throw new Error("no session");
      },
    });

    const response = await answer(request(), ID);

    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe(
      "IDENTITY_REQUIRED",
    );
    expect(joined).toEqual([]);
  });

  test("Intelligence's refusal keeps its public code, words and status", async () => {
    const refused = Object.assign(new Error("Trajectories are off."), {
      name: "TrajectoryConnectionError",
      code: "TRAJECTORIES_NOT_ENABLED",
      status: 403,
    });
    const { answer } = connect({
      join: async () => {
        throw refused;
      },
    });

    const response = await answer(request(), ID);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code: "TRAJECTORIES_NOT_ENABLED",
      message: "Trajectories are off.",
    });
  });

  test("anything else is CONNECTION_FAILED, and its own words are not passed on", async () => {
    const { answer } = connect({
      join: async () => {
        throw new Error("ECONNREFUSED 10.0.0.7 key=secret");
      },
    });

    const response = await answer(request(), ID);

    expect(response.status).toBe(502);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      code: "CONNECTION_FAILED",
      message: "Could not connect to Intelligence",
    });
    expect(body).not.toContain("secret");
  });
});
