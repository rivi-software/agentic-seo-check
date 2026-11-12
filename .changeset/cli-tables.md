---
"@rivi-software/agentic-seo-check": minor
---

The CLI's text report shows its lists as tables, each with a header row in a rounded frame (issue #154): a crawl's pages, its findings by rule and its field data, and the rules of each category that `agentic-seo-check rules` lists. Before, they had no headers: nothing said that a page's first number was its score, and the rule ids and the field data's values started wherever the text before them ended. The field data now has a column for each metric. The last column of a table wraps, and a path too long for it breaks inside the path; when the other columns leave it too little room, its text goes under each row. Text from a page in Japanese, Chinese or Korean, or with emoji, counts as the two columns a terminal draws it in, so the frames and the wrapped text stay in line. The JSON and the Markdown report are unchanged.
