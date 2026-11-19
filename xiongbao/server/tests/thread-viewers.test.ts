import { describe, expect, test } from "bun:test";
import { Observable, of, Subject } from "rxjs";
import {
  threadViewers,
  watched,
  watchThread,
} from "../src/threads/thread-viewers";

/**
 * Who is looking at a conversation is the number of streams held open on it (期九·五). The count is the
 * server's only evidence that a page is on a thread, so it has to go up when a page subscribes and come
 * back down however the page goes: the turn ending, an error, or the browser simply hanging up.
 */
describe("the streams that watch a thread", () => {
  test("a thread nobody opened has no viewers", () => {
    expect(threadViewers("alice", "t-none")).toBe(0);
  });

  test("each stream counts while it is subscribed and stops counting when it is unsubscribed", () => {
    const source = new Subject<string>();
    const stream = watched("alice", "t-1", source);
    expect(threadViewers("alice", "t-1")).toBe(0);
    const first = stream.subscribe();
    const second = stream.subscribe();
    expect(threadViewers("alice", "t-1")).toBe(2);
    first.unsubscribe();
    expect(threadViewers("alice", "t-1")).toBe(1);
    second.unsubscribe();
    expect(threadViewers("alice", "t-1")).toBe(0);
  });

  test("a stream that completes or fails stops counting", () => {
    const done = watched("alice", "t-2", of(1, 2, 3));
    const seen: number[] = [];
    done.subscribe((value) => seen.push(value));
    expect(seen).toEqual([1, 2, 3]);
    expect(threadViewers("alice", "t-2")).toBe(0);

    const broken = watched(
      "alice",
      "t-2",
      new Observable<number>((subscriber) => subscriber.error(new Error("x"))),
    );
    broken.subscribe({ error: () => undefined });
    expect(threadViewers("alice", "t-2")).toBe(0);
  });

  test("a viewer is still counted while the turn's last events are delivered to it", () => {
    const source = new Subject<string>();
    const counts: number[] = [];
    watched("alice", "t-3", source).subscribe({
      next: () => counts.push(threadViewers("alice", "t-3")),
    });
    source.next("a");
    source.next("b");
    expect(counts).toEqual([1, 1]);
  });

  test("releasing twice does not take another viewer's place", () => {
    const one = watchThread("alice", "t-4");
    const other = watchThread("alice", "t-4");
    one();
    one();
    expect(threadViewers("alice", "t-4")).toBe(1);
    other();
    expect(threadViewers("alice", "t-4")).toBe(0);
  });

  test("another person's viewers are not this person's, even on a thread with the same id", () => {
    const release = watchThread("bob", "t-5");
    expect(threadViewers("alice", "t-5")).toBe(0);
    expect(threadViewers("bob", "t-5")).toBe(1);
    release();
  });
});
