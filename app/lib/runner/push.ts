import { Readable } from "node:stream";

export async function candidatePush(source: Readable, turnId: string, checkpointSequence?: number): Promise<Readable> {
  const iterator = source[Symbol.asyncIterator]();
  let prefix = Buffer.alloc(0);
  let length = 0;
  try {
    while (!length || prefix.length < length + 4) {
      const next = await iterator.next();
      if (next.done) throw new Error("Incomplete Git push.");
      prefix = Buffer.concat([prefix, Buffer.from(next.value)]);
      if (prefix.length >= 4 && !length) {
        const header = prefix.subarray(0, 4).toString("ascii");
        if (!/^[0-9a-f]{4}$/i.test(header)) throw new Error("Invalid Git packet.");
        length = Number.parseInt(header, 16);
        if (length < 5 || length > 10000) throw new Error("Invalid Git command size.");
      }
    }
    if (checkpointSequence !== undefined && (!Number.isSafeInteger(checkpointSequence) || checkpointSequence < 1 || checkpointSequence > 120)) throw new Error("Invalid checkpoint sequence.");
    const expectedRef = checkpointSequence === undefined ? `refs/turns/${turnId}` : `refs/checkpoints/${turnId}/${checkpointSequence}`;
    const command = prefix.subarray(4, length).toString("utf8").split("\0")[0].trim();
    const [oldSha, newSha, ref, extra] = command.split(" ");
    if (oldSha !== "0".repeat(40) || !/^[0-9a-f]{40}$/.test(newSha) ||
        ref !== expectedRef || extra || prefix.subarray(length, length + 4).toString() !== "0000") {
      throw new Error("A runner may only create its own immutable turn ref. Update the runner if necessary.");
    }
  } catch (cause) {
    source.destroy();
    throw cause;
  }
  return Readable.from((async function* () {
    let bytes = prefix.length;
    try {
      yield prefix;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        bytes += next.value.length;
        if (bytes > 128 * 1024 * 1024) throw new Error("Git push exceeds 128 MB.");
        yield next.value;
      }
    } finally {
      source.destroy();
    }
  })());
}
