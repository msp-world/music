import { MSPNode, installShutdownHooks, mspOptionsFromEnv } from "../shared/msp.ts";
import { MusicWorld } from "./world.ts";

export async function startMusicNode(): Promise<{ node: MSPNode; world: MusicWorld }> {
  const node = new MSPNode(process.env.MUSIC_NODE_ID || "music", mspOptionsFromEnv("MUSIC"));
  const world = new MusicWorld();
  world.attach(node);
  const ep = await node.start();
  world.start();
  console.log(`[music] MSP node "${node.nodeId}" listening on ${ep.host}:${ep.port}`);
  return { node, world };
}

if (import.meta.main) {
  const { node, world } = await startMusicNode();
  installShutdownHooks(() => {
    world.stop();
    node.stop();
  });
}
