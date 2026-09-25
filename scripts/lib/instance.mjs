/**
 * 「端口上那个进程是不是我们的」—— 实例身份判定的**唯一**实现。
 *
 * ## 为什么要单独一个模块
 *
 * `service.mjs` 要用它决定能否发 SIGTERM,`doctor.mjs` 要用它决定第 2 层
 * 是否通过。这是**同一个问题**,而本项目已经被「并行手写的两份判断」咬过
 * 三次(端口解析三处、守卫名单两份、默认值两份),每次的分叉方向都是
 * **有一处被漏掉**。
 *
 * 身份判定尤其不能有两份:两者一旦分叉,`doctor` 会说「服务正常」而
 * `service.mjs` 说「无法确认身份,未发送信号」—— 用户拿到两句互相矛盾的话,
 * 而两句都出自本项目。
 *
 * ## 两条独立途径,缺一不可
 *
 *   1. `/health` 回报的 pid 与状态文件一致 —— 服务健康时的强证明
 *      (能应答我们端口的进程,就是占着这个端口的进程)
 *   2. `/proc/<pid>/cmdline` 含我们的入口路径 —— 服务卡死不应答时的兜底
 *
 * 两条都不成立就**拒绝断言身份**。宁可让用户手工处理,也不能替他杀一个
 * 不知道是什么的进程。
 *
 * ## 这里刻意**不** import zod / HealthSchema
 *
 * `npm run status` 全程只有 51ms,而经 `config.ts` 引一次 schema 要 **57ms**
 * —— 把一个常用 CLI 的启动时间翻倍(见 `store/paths.ts` 的说明)。
 * 所以本模块只做**结构检查**:`ok === true` + `pid` 是数 + `version` 是串。
 *
 * 那已经比「只看 `body.ok === true`」强得多:`pid` 是必需字段,而一个恰好
 * 回 `{"ok":true}` 的**别的**本机服务会被这条检查挡下来 —— 本机就真有过
 * 一个监听 9876 的旧项目,而端口是可配的,撞上并非假想。
 *
 * `doctor.mjs` 允许慢,它在此之上**再**过一遍 `HealthSchema`(完整契约),
 * 于是「结构像」与「契约合」两级都有人验。
 */

import { readFile, readlink } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * 构造一个实例视图。
 *
 * 做成工厂而不是一组自由函数:`dataDir` / `port` / `entry` 三者必须**成套**
 * 使用 —— 用 A 目录的状态文件去探 B 端口的健康,得到的身份判断是无意义的。
 * 工厂让这三个值在一处绑定,调用方拿不到「只传了一半」的形态。
 */
export function createInstance({ dataDir, port, entry, altEntries = [] }) {
  const stateFile = join(dataDir, "zen-gateway.state.json");
  const base = `http://127.0.0.1:${port}`;
  /**
   * 认得出「是我们的代码」的全部入口。
   *
   * `entry` 是构建产物(`npm start` 走它),`altEntries` 是别的启动方式 ——
   * `npm run dev:server` 跑的是 `src/server/index.ts`,那种进程**没有状态文件**
   * 却确实是本项目。`service.mjs` 只认 `entry`(它只管自己启的那个),
   * `doctor.mjs` 要认全部(它要如实描述端口上是什么)。
   */
  const knownEntries = [entry, ...altEntries];

  /** 状态文件。内容不可信 —— pid 可能已被系统复用,也可能是半截写入。 */
  async function readState() {
    try {
      const raw = JSON.parse(await readFile(stateFile, "utf8"));
      const pid = Number.parseInt(raw?.pid, 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      return { pid, port: Number(raw?.port) || port, startedAt: raw?.startedAt ?? null };
    } catch {
      return null;
    }
  }

  function pidAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM = 进程存在但不属于当前用户 —— 存活,但绝不是我们启的。
      return err?.code === "EPERM";
    }
  }

  /**
   * 身份验证途径 2:进程的 cmdline 是否指向我们的入口。
   *
   * 服务卡死不应答 `/health` 时,这是唯一还能用的证明。没有它就只能在
   * 「拒绝停止一个卡死的服务」和「盲杀一个 PID」之间二选一。
   *
   * ## cmdline 里的路径可能是**相对**的,必须按持有者的 cwd 解析
   *
   * 实测:`node dist/server/server/index.js` 的 cmdline 里就是那个相对路径,
   * 而 `entry` 是绝对路径 —— 直接字符串相等会判不出来。`npm run dev:server`
   * 跑的 `src/server/index.ts` 同理。
   *
   * `service.mjs` 的锁逻辑早就踩过并解决了这个问题(见它那里的
   * `cmdlinePointsAtScript`),而这里先前是直接相等比较 —— 同一个坑的两份
   * 代码里只有一份修好了。这正是把身份判定收进本模块要消除的那种分叉。
   *
   * 相对路径要相对**持有者的** cwd 解析,所以先读 `/proc/<pid>/cwd`;
   * 读不到就退回本进程的 cwd(同一个 npm 脚本通常同 cwd)。
   *
   * 返回 `null` 表示**这条途径不可用**(非 Linux、无权读 /proc),
   * 与 `false`(读到了,确认不是我们)必须分开 —— 前者要交给调用方保守处理,
   * 后者是一个肯定的否定答案。
   */
  async function pidLooksLikeOurs(pid) {
    let cmdline;
    try {
      cmdline = await readFile(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return null;
    }

    let cwd = process.cwd();
    try {
      cwd = await readlink(`/proc/${pid}/cwd`);
    } catch {
      /* 退回本进程 cwd */
    }

    const args = cmdline.split("\0").filter(Boolean);
    return args.some((arg) => knownEntries.some((e) => arg === e || resolve(cwd, arg) === e));
  }

  /**
   * 探一次 `/health`。
   *
   * 结构不合的一律当作「不是我们的服务」而返回 null —— 见模块头说明。
   */
  async function probeHealth(timeoutMs = 1000) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = await res.json();
      if (body?.ok !== true) return null;
      // pid 是判定身份的那个字段,缺了它这次应答对我们毫无用处。
      if (typeof body.pid !== "number" || !Number.isInteger(body.pid)) return null;
      if (typeof body.version !== "string") return null;
      return body;
    } catch {
      return null;
    }
  }

  /**
   * 把「端口上在跑什么」「状态文件指向什么」「它是不是我们的」一次问清。
   *
   * **只读,不做任何清理** —— 先前 service.mjs 的实现顺手删陈旧状态文件,
   * 结果在「本服务存活但不健康」这条路径上删掉了**活着的**实例的状态文件,
   * 之后 stop 与 status 都报「未在运行」,只能手工 ss/kill 收场。
   * doctor 更是绝不该写任何东西。
   */
  async function inspect() {
    const state = await readState();
    const health = await probeHealth();
    const alive = state !== null && pidAlive(state.pid);

    let identity = "unknown";
    if (alive) {
      if (health !== null) {
        // 能应答我们端口的进程就是占着这个端口的进程。
        identity = health.pid === state.pid ? "ours" : "foreign";
      } else {
        const byCmdline = await pidLooksLikeOurs(state.pid);
        if (byCmdline === true) identity = "ours";
        else if (byCmdline === false) identity = "foreign";
      }
    }

    /*
     * 「端口上有我们的服务,但它不是 service.mjs 启的」—— 独立一态。
     *
     * `npm run dev:server` 起的进程没有状态文件,先前会被判成
     * `foreignOnPort`,于是 doctor 报「端口被另一个进程占用」并让用户去
     * `ss -ltnp` 查一个**其实是他自己刚启动的开发服务器**。
     *
     * 这一态对两个消费者的意义**相反**,所以只给事实不给结论:
     *   - `service.mjs`:仍然不能对它发 SIGTERM(不是它启的,没有状态文件
     *     作依据),继续走 foreignOnPort 那条拒绝路径 —— 保守是对的。
     *   - `doctor.mjs`:它要如实描述,所以据此报「本项目的服务,但非 npm start
     *     启动」而不是「陌生进程」。
     *
     * 判定只靠 cmdline —— 那是唯一可用的证据(没有状态文件可比对 pid)。
     * 读不到 /proc 时为 null,调用方按「不确定」处理。
     */
    let unregisteredOurs = false;
    if (health !== null && state === null) {
      unregisteredOurs = (await pidLooksLikeOurs(health.pid)) === true;
    }

    return {
      state,
      health,
      alive,
      identity,
      healthy: health !== null,
      /** 端口上有服务,但不是状态文件记录的那个(或根本没有状态文件)。 */
      foreignOnPort: health !== null && (state === null || health.pid !== state.pid),
      /** 那个「陌生」进程其实跑的是本项目的代码(典型:npm run dev:server)。 */
      unregisteredOurs,
    };
  }

  return { base, stateFile, readState, pidAlive, pidLooksLikeOurs, probeHealth, inspect };
}

/**
 * `data/` 的位置。
 *
 * 与 `src/store/paths.ts` 的 `dataDir()` **刻意保持同一套优先级**
 * (显式 root > `ZG_DATA_DIR` > `cwd/data`),但这里不 import 它:
 * 那个模块虽然只依赖 `node:path`,却是 TypeScript —— 而 `.mjs` 脚本引它要走
 * Node 的 strip-only 模式,实测那一步本身有 17ms 开销。
 *
 * 不构成「两份真相」:本函数只在 `ZG_DATA_DIR` 未设时使用 `root`,
 * 而 `root` 由调用方从脚本自身位置算出 —— 这正是 `paths.ts` 那条
 * 「显式 root 优先」约定的调用方一侧。两者的对应关系在 `service.mjs`
 * 传参处有说明。
 */
export function dataDirOf(root) {
  const override = process.env.ZG_DATA_DIR;
  return override !== undefined && override !== "" ? resolve(override) : join(root, "data");
}
