/** The tables of a text report, each as its lines from the top of its frame to the bottom. */
export const tablesOf = (text: string): string[][] => {
  const tables: string[][] = [];
  let open: string[] | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("  ╭")) {
      open = [];
    }

    open?.push(line);

    if (open && line.startsWith("  ╰")) {
      tables.push(open);
      open = null;
    }
  }

  return tables;
};

/** A line of a table as its cells: what two or more spaces part between the frame's sides. */
export const cellsOf = (line: string): string[] =>
  line.slice(4, -2).trim().split(/ {2,}/u);

/** The first table after the heading that starts with `title`, header included, as rows of cells. */
export const tableUnder = (text: string, title: string): string[][] => {
  const [lines = []] = tablesOf(text.slice(text.indexOf(`\n${title}`)));

  return lines.filter((line) => line.startsWith("  │")).map(cellsOf);
};
