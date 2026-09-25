import { describe, expect, it } from "vitest";
import {
  BATCH_STATES,
  INITIAL,
  isActive,
  percentages,
  pollIntervalMs,
  reduce,
  type BatchEvent,
  type BatchProgress,
  type BatchState,
} from "../../src/shared/batchProbe.ts";

/*
 * 批量探测状态机（纯 reducer）。
 *
 * 它是本后台**唯一**的长任务，而边界条件里有好几条是「错了不报错、只是行为
 * 怪」的类型（取消后又收到旧响应、暂停期间进度继续涨、两段进度合成一个假
 * 百分比）。纯函数让每条转移都能用一行断言钉住。
 */

/** 依次喂一串事件。 */
function run(events: BatchEvent[], from: BatchProgress = INITIAL): BatchProgress {
  return events.reduce(reduce, from);
}

describe("状态机的合法转移", () => {
  it("start 只能从 idle 或 done 开始", () => {
    expect(reduce(INITIAL, { type: "start", screenTotal: 3 }).state).toBe("screening");

    const done = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 1 },
      { type: "probed" },
      { type: "finished" },
    ]);
    expect(done.state).toBe("done");
    // 跑完之后可以再来一批。
    expect(reduce(done, { type: "start", screenTotal: 2 }).state).toBe("screening");
  });

  it("运行中再点 start **无效** —— 两批并发会互相切 selector", () => {
    const running = run([
      { type: "start", screenTotal: 2 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 2 },
    ]);
    expect(running.state).toBe("running");

    /*
     * selector 的选中节点是**进程外的全局状态**：两批并发会换掉对方的出口，
     * 于是实测到的 IP 不是转发实际会用的那个 —— 而隔离报告正按它分组。
     * 这条断言钉住「第二次 start 什么都不改变」，包括进度不被重置。
     */
    const after = reduce(running, { type: "start", screenTotal: 99 });
    expect(after).toBe(running); // 同一个对象 —— 完全没动
  });

  it("start 会清掉上一批的残留", () => {
    const first = run([
      { type: "start", screenTotal: 2 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 2 },
      { type: "probed", addedWorkerId: "w9" },
      { type: "finished", failureKind: "cancelled" },
    ]);
    expect(first.addedWorkerIds).toEqual(["w9"]);
    expect(first.failureKind).toBe("cancelled");

    const second = reduce(first, { type: "start", screenTotal: 1 });
    // 上一批的 addedWorkerIds 与 failureKind 不能漏进新的一批。
    expect(second.addedWorkerIds).toEqual([]);
    expect(second.failureKind).toBeNull();
  });

  it("不合法的转移返回**同一个对象**，不抛异常", () => {
    /*
     * 事件来自轮询与用户点击两个源，可以乱序到达（用户在 done 之后又点暂停、
     * 旧的一条 probed 在 finished 之后才到）。抛异常会让一次无害的竞态
     * 变成一个错误页。
     */
    for (const event of [
      { type: "screened" },
      { type: "probed" },
      { type: "pause" },
      { type: "resume" },
      { type: "cancel" },
      { type: "finished" },
    ] satisfies BatchEvent[]) {
      expect(reduce(INITIAL, event)).toBe(INITIAL);
    }
  });
});

describe("暂停期间进度不推进", () => {
  it("paused 时收到 probed **不涨** —— 那是暂停的全部含义", () => {
    const paused = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 5 },
      { type: "probed" },
      { type: "pause" },
    ]);
    expect(paused.state).toBe("paused");
    expect(paused.mainDone).toBe(1);

    /*
     * 暂停是前端/执行器的状态，而**在途的探测请求仍会回来**（一次桥接探测
     * 可能几秒）。若照收，暂停期间进度条继续涨，用户会以为暂停没生效。
     */
    const after = reduce(paused, { type: "probed" });
    expect(after.mainDone).toBe(1);
    expect(after).toBe(paused);
  });

  it("resume 之后恢复推进", () => {
    const resumed = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 5 },
      { type: "pause" },
      { type: "resume" },
      { type: "probed" },
    ]);
    expect(resumed.state).toBe("running");
    expect(resumed.mainDone).toBe(1);
  });

  it("只有主探测段能暂停（筛选段很快，暂停它没有意义）", () => {
    const screening = reduce(INITIAL, { type: "start", screenTotal: 3 });
    expect(reduce(screening, { type: "pause" })).toBe(screening);
  });
});

describe("cancelling 是独立中间态", () => {
  it("cancel 进 cancelling 而不是直接 done", () => {
    const running = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 3 },
    ]);
    const cancelling = reduce(running, { type: "cancel" });

    /*
     * 取消是「请求已发出、等服务端确认」。直接回 idle/done 的话按钮立刻变成
     * 「开始」，而后台那一批还在跑（它要切 selector）—— 用户此时再点开始
     * 就会有两批并发。
     */
    expect(cancelling.state).toBe("cancelling");
    expect(cancelling.cancelRequested).toBe(true);
    // 仍算「进行中」—— 按钮该保持禁用。
    expect(isActive(cancelling)).toBe(true);
  });

  it("重复点取消不产生变化", () => {
    const cancelling = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 3 },
      { type: "cancel" },
    ]);
    expect(reduce(cancelling, { type: "cancel" })).toBe(cancelling);
  });

  it("cancelling 之后 finished 才真正结束", () => {
    const done = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 3 },
      { type: "cancel" },
      { type: "finished", failureKind: "cancelled" },
    ]);
    expect(done.state).toBe("done");
    expect(done.failureKind).toBe("cancelled");
    expect(isActive(done)).toBe(false);
  });

  it("idle 时 cancel 无效（没有东西可取消）", () => {
    expect(reduce(INITIAL, { type: "cancel" })).toBe(INITIAL);
  });

  it("筛选段也能取消", () => {
    const screening = reduce(INITIAL, { type: "start", screenTotal: 5 });
    expect(reduce(screening, { type: "cancel" }).state).toBe("cancelling");
  });
});

describe("计数不越界", () => {
  it("screened 不超过 screenTotal", () => {
    const p = run([
      { type: "start", screenTotal: 2 },
      { type: "screened" },
      { type: "screened" },
      { type: "screened" },
      { type: "screened" },
    ]);
    // 「4/2」会让用户以为数字是乱的。
    expect(p.screenDone).toBe(2);
  });

  it("probed 不超过 mainTotal", () => {
    const p = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 2 },
      { type: "probed" },
      { type: "probed" },
      { type: "probed" },
    ]);
    expect(p.mainDone).toBe(2);
  });

  it("screenDone 把筛选段标记为完成（哪怕有节点没通过）", () => {
    const p = run([
      { type: "start", screenTotal: 5 },
      { type: "screened" },
      // 只筛了 1 个就进主段 —— 现实中不会，但要保证显示不是「1/5 已完成」
      { type: "screenDone", mainTotal: 1 },
    ]);
    // 筛选段确实结束了，所以显示为满。
    expect(p.screenDone).toBe(5);
    expect(p.screenTotal).toBe(5);
  });

  it("负的总数被夹到 0", () => {
    expect(reduce(INITIAL, { type: "start", screenTotal: -5 }).screenTotal).toBe(0);
  });
});

describe("两段进度不合成一个百分比", () => {
  it("分母为 0 时给 null 而不是 0 或 100", () => {
    /*
     * 「还没开始」与「0% 完成」是两件事 —— UI 要显示「—」而不是一根空进度条。
     */
    expect(percentages(INITIAL)).toEqual({ screen: null, main: null });
  });

  it("两段各自算，不给总百分比", () => {
    const p = run([
      { type: "start", screenTotal: 4 },
      { type: "screened" },
      { type: "screened" },
      { type: "screened" },
      { type: "screened" },
      { type: "screenDone", mainTotal: 2 },
      { type: "probed" },
    ]);
    const pct = percentages(p);
    expect(pct.screen).toBe(100);
    expect(pct.main).toBe(50);

    /*
     * `percentages` 的返回值里**只有这两个键** —— 没有 total。
     * 合成总百分比要给两段定权重，而筛选（纯本地）比主探测（真发请求 +
     * 切 selector）快得多，于是进度条会先飞到 40% 再慢慢爬。
     */
    expect(Object.keys(pct).sort()).toEqual(["main", "screen"]);
  });
});

describe("轮询间隔", () => {
  it("进行中 500ms，其余 5000ms", () => {
    expect(pollIntervalMs(INITIAL)).toBe(5000);

    const running = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 1 },
    ]);
    expect(pollIntervalMs(running)).toBe(500);

    const paused = reduce(running, { type: "pause" });
    // 暂停时不需要快 —— 没有东西在变。
    expect(pollIntervalMs(paused)).toBe(5000);

    const cancelling = reduce(running, { type: "cancel" });
    // 取消中要快:我们在等服务端确认，而那随时会到。
    expect(pollIntervalMs(cancelling)).toBe(500);
  });
});

describe("状态字母表与库的 CHECK 同源", () => {
  it("六个状态都能被 reducer 产出", () => {
    /*
     * `batch_probe_jobs.state` 的 CHECK 约束列的就是这六个（Phase 1 建表时
     * 按规划的状态机定的）。少一个会让那个状态的落盘在运行期被 SQLite 拒。
     *
     * 这条断言确认字母表**完整且每个都可达** —— 一个永不出现的状态是死信息，
     * 而一个能出现但不在字母表里的状态会让写库失败。
     */
    const reachable = new Set<BatchState>(["idle"]); // INITIAL

    const screening = reduce(INITIAL, { type: "start", screenTotal: 1 });
    reachable.add(screening.state);
    const running = reduce(reduce(screening, { type: "screened" }), {
      type: "screenDone",
      mainTotal: 1,
    });
    reachable.add(running.state);
    reachable.add(reduce(running, { type: "pause" }).state);
    reachable.add(reduce(running, { type: "cancel" }).state);
    reachable.add(reduce(running, { type: "finished" }).state);

    expect([...reachable].sort()).toEqual([...BATCH_STATES].sort());
  });
});

describe("addedWorkerIds", () => {
  it("累积批测过程中新建的 Worker id（结束后可跳转查看）", () => {
    const p = run([
      { type: "start", screenTotal: 1 },
      { type: "screened" },
      { type: "screenDone", mainTotal: 3 },
      { type: "probed", addedWorkerId: "w1" },
      { type: "probed" },
      { type: "probed", addedWorkerId: "w2" },
    ]);
    expect(p.addedWorkerIds).toEqual(["w1", "w2"]);
  });
});
