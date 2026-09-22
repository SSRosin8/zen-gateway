import { describe, expect, it } from "vitest";
import { SelectorLock, SelectorLockRegistry } from "../../src/core/proxy/selectorLock.ts";

/*
 * 这把锁保护的是 Clash selector 的全局状态。
 *
 * 所有桥接代理都经同一个本地混合端口出去,走哪个节点由 selector 的 `now`
 * 决定。两个并发请求各自切换 selector 就会互相换掉对方的出口节点 ——
 * 于是 Worker A 的流量从 Worker B 的 IP 出去,出口隔离彻底失效。
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("SelectorLock", () => {
  it("串行执行:临界区不重叠", async () => {
    const lock = new SelectorLock();
    const events: string[] = [];

    const task = (id: string, delay: number) =>
      lock.run(async () => {
        events.push(`${id}-enter`);
        await sleep(delay);
        events.push(`${id}-exit`);
      });

    // 故意让先启动的那个更慢:无锁时它的 exit 会排在后者 enter 之后。
    await Promise.all([task("a", 30), task("b", 1), task("c", 1)]);

    expect(events).toEqual([
      "a-enter",
      "a-exit",
      "b-enter",
      "b-exit",
      "c-enter",
      "c-exit",
    ]);
  });

  it("保持提交顺序", async () => {
    const lock = new SelectorLock();
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3, 4].map((i) =>
        lock.run(async () => {
          // 反向延迟:若不保序,完成顺序会与提交顺序相反。
          await sleep((5 - i) * 4);
          order.push(i);
        }),
      ),
    );

    expect(order).toEqual([0, 1, 2, 3, 4]);
  });

  it("任务抛错不会断链,后续任务照常执行", async () => {
    const lock = new SelectorLock();
    const done: string[] = [];

    const failed = lock.run(async () => {
      throw new Error("切换 selector 失败");
    });

    await expect(failed).rejects.toThrow("切换 selector 失败");

    // 一次失败若污染了锁链尾部,后面所有任务都会被同一个 rejection 拖挂。
    await lock.run(async () => {
      done.push("after");
    });

    expect(done).toEqual(["after"]);
  });

  it("失败任务的异常传给调用方,而不是变成未处理拒绝", async () => {
    const lock = new SelectorLock();
    const results = await Promise.allSettled([
      lock.run(async () => {
        throw new Error("第一个失败");
      }),
      lock.run(async () => "第二个成功"),
    ]);

    expect(results[0]!.status).toBe("rejected");
    expect(results[1]!).toMatchObject({ status: "fulfilled", value: "第二个成功" });
  });

  it("返回任务的结果", async () => {
    const lock = new SelectorLock();
    await expect(lock.run(async () => 42)).resolves.toBe(42);
  });

  it("全部完成后 pending 归零", async () => {
    const lock = new SelectorLock();
    const running = Promise.all([
      lock.run(() => sleep(5)),
      lock.run(() => sleep(5)),
      lock.run(() => sleep(5)),
    ]);
    expect(lock.pending).toBe(3);
    await running;
    expect(lock.pending).toBe(0);
  });

  it("失败后 pending 也归零", async () => {
    const lock = new SelectorLock();
    await lock.run(async () => {
      throw new Error("x");
    }).catch(() => {});
    expect(lock.pending).toBe(0);
  });

  it("任务返回响应对象时,锁在响应头到达即释放", async () => {
    /*
     * 临界区的正确边界是 fetch() 的 resolve 时机 —— 响应头到达、连接已
     * 绑定到当时选中的节点。之后读响应体必须在锁外,否则一条几分钟的 SSE
     * 会把整个网关串行化。
     */
    const lock = new SelectorLock();
    let bodyRead = false;

    // 模拟 fetch:resolve 出一个响应对象,响应体是它上面的惰性方法。
    const fakeFetch = async () => ({
      async text() {
        await sleep(30);
        bodyRead = true;
        return "ok";
      },
    });

    const response = await lock.run(fakeFetch);

    // 锁已释放,而响应体尚未读取。
    expect(bodyRead).toBe(false);
    let secondRan = false;
    await lock.run(async () => {
      secondRan = true;
    });
    expect(secondRan).toBe(true);
    expect(bodyRead).toBe(false);

    await response.text();
    expect(bodyRead).toBe(true);
  });

  it("任务返回 Promise 时锁被延长 —— 照抄本模式时最容易踩的坑", async () => {
    /*
     * `.then()` 会自动 await 任务返回的 Promise(Promise 同化),
     * 于是「把读体也写进任务」会让锁一直持到整个响应体读完。
     * 区别只在返回值是响应对象还是读体的 Promise,不看类型签名极易写错,
     * 所以把这个事实钉成可执行的断言。
     */
    const lock = new SelectorLock();
    const events: string[] = [];

    const wrong = lock.run(async () => {
      events.push("a-headers");
      // 错误形态:响应体的读取也在任务内。
      await sleep(20);
      events.push("a-body-done");
    });
    const other = lock.run(async () => {
      events.push("b-enter");
    });

    await Promise.all([wrong, other]);

    // b 只能等 a 的响应体读完。
    expect(events).toEqual(["a-headers", "a-body-done", "b-enter"]);
  });
});

describe("SelectorLockRegistry", () => {
  it("同一内核复用同一把锁", () => {
    const reg = new SelectorLockRegistry();
    expect(reg.forBridge("b1")).toBe(reg.forBridge("b1"));
    expect(reg.size).toBe(1);
  });

  it("不同内核互不阻塞", async () => {
    // 不同 Clash 内核的 selector 彼此独立,串行化它们是无谓的性能损失。
    const reg = new SelectorLockRegistry();
    const events: string[] = [];

    await Promise.all([
      reg.forBridge("b1").run(async () => {
        events.push("b1-enter");
        await sleep(20);
        events.push("b1-exit");
      }),
      reg.forBridge("b2").run(async () => {
        events.push("b2-enter");
        await sleep(1);
        events.push("b2-exit");
      }),
    ]);

    // b2 应当在 b1 还占着自己那把锁时就跑完。
    expect(events.indexOf("b2-exit")).toBeLessThan(events.indexOf("b1-exit"));
    expect(reg.size).toBe(2);
  });
});
