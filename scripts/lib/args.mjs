/**
 * CLI 参数校验 —— `setup` 与 `doctor` 共用。
 *
 * 未识别的参数必须拒绝：`setup` 会写 `data/config.json`（唯一的凭证存储），
 * 静默忽略 `--help` 之类的错参数就会变成一次真实导入。
 * 两个脚本共用一份，避免新增 flag 时只有一处跟上（纪律 #4）。
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
    // npm 会吞掉 `npm run setup --dry-run` 里的 flag，必须写 `--` 才能传到脚本。
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
      // 退出码非 0，让 `npm run setup -- --typo && 下一步` 这类串联停下。
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
