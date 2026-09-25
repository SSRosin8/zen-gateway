/**
 * CLI 参数校验 —— `setup` 与 `doctor` 共用。
 *
 * ## 为什么必须拒绝未识别的参数
 *
 * 两个脚本先前都只做 `process.argv.includes("--x")`，于是**任何拼错或想象出来
 * 的参数都被静默忽略，脚本照常执行完整流程**。
 *
 * 对 `doctor` 那只是白跑一趟；对 `setup` 后果实打实：它会写
 * `data/config.json` —— 那是**唯一一份凭证存储**（Worker 的 apiKey、Relay Token、
 * Controller secret）。一个照着文档摸索用法的人敲 `npm run setup -- --help`
 * 期望看到用法说明，得到的是一次真实导入：代理 3→72、桥接 2→3、
 * 外加一个 `config.json.bak`。**本轮审核就是这么踩到的。**
 *
 * 这与 `--dry-run` 的存在互为印证：脚本自己承认「写盘前该让人先看一眼」，
 * 而未知参数被忽略恰好绕过了那个机会。
 *
 * ## 为什么两个脚本共用一份
 *
 * 纪律 #4：各写一份的话，新增一个 flag 时只有一处会跟上，而**分叉方向是漏**
 * —— 漏掉校验的那个脚本继续静默接受错参数。
 */

/**
 * 校验 `process.argv` 里的参数，发现未识别的就打印用法并退出。
 *
 * @param {object} spec
 * @param {string} spec.command 命令名，用于用法示例（如 `npm run setup`）
 * @param {string} spec.summary 一行说明
 * @param {Array<{flag: string, takesValue?: boolean, help: string}>} spec.flags 认识的 flag
 * @param {string[]} [spec.argv] 待校验的参数（默认 `process.argv.slice(2)`，便于测试）
 * @param {(code: number) => never} [spec.exit] 退出方式（默认 `process.exit`，便于测试）
 * @param {(text: string) => void} [spec.write] 输出方式（默认 `console.log`，便于测试）
 * @returns {boolean} `true` 表示参数合法且不是 `--help`；调用方据此决定是否继续
 */
export function checkArgs(spec) {
  const argv = spec.argv ?? process.argv.slice(2);
  const exit = spec.exit ?? ((code) => process.exit(code));
  const write = spec.write ?? ((text) => console.log(text));

  const known = new Map(spec.flags.map((f) => [f.flag, f]));

  const usage = () => {
    write(`${spec.summary}\n`);
    write(`用法: ${spec.command} [选项]\n`);
    for (const f of spec.flags) {
      const label = f.takesValue === true ? `${f.flag} <值>` : f.flag;
      write(`  ${label.padEnd(22)}${f.help}`);
    }
    write(`  ${"--help".padEnd(22)}打印这段说明`);
    /*
     * 明写 `--` —— npm 会把 `npm run setup --dry-run` 的 flag 吃掉当成自己的，
     * 必须写 `npm run setup -- --dry-run` 才能传到脚本。这是个高频困惑点，
     * 而它的症状恰好是本模块要防的那个：flag 没传到，脚本照常跑完。
     */
    write(`\n经 npm 调用时 flag 前要加 \`--\`，例如 \`${spec.command} -- ${spec.flags[0]?.flag ?? "--help"}\`。`);
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      usage();
      exit(0);
      return false;
    }

    const spec1 = known.get(arg);
    if (spec1 === undefined) {
      /*
       * 拒绝而不是忽略，且**退出码非 0** —— 让 `npm run setup -- --typo && 下一步`
       * 这样的串联在参数写错时停下，而不是带着一个没生效的 flag 继续。
       */
      write(`✗ 未识别的参数: ${arg}\n`);
      usage();
      exit(1);
      return false;
    }

    // 带值的 flag 要吃掉它的值，否则那个值本身会被当成未识别的参数。
    if (spec1.takesValue === true) {
      if (i + 1 >= argv.length) {
        write(`✗ ${arg} 需要一个值\n`);
        usage();
        exit(1);
        return false;
      }
      i += 1;
    }
  }

  return true;
}
