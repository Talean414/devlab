// Line-based LCS diff producing unified rows for the self-healing viewer.

export interface DiffRow {
  type: "same" | "add" | "del";
  text: string;
  lineOld?: number;
  lineNew?: number;
}

export function computeDiff(oldText: string, newText: string): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length, n = b.length;

  // LCS table (trim to keep memory sane for huge files)
  const MAX = 3000;
  if (m + n > MAX) {
    return [
      ...a.map((t) => ({ type: "del" as const, text: t })),
      ...b.map((t) => ({ type: "add" as const, text: t })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0, j = 0, oldLn = 1, newLn = 1;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      rows.push({ type: "same", text: a[i], lineOld: oldLn++, lineNew: newLn++ });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", text: a[i], lineOld: oldLn++ });
      i++;
    } else {
      rows.push({ type: "add", text: b[j], lineNew: newLn++ });
      j++;
    }
  }
  while (i < m) rows.push({ type: "del", text: a[i], lineOld: oldLn++ }), i++;
  while (j < n) rows.push({ type: "add", text: b[j], lineNew: newLn++ }), j++;
  return rows;
}

export function diffStats(rows: DiffRow[]) {
  let adds = 0, dels = 0;
  for (const r of rows) {
    if (r.type === "add") adds++;
    if (r.type === "del") dels++;
  }
  return { adds, dels };
}
