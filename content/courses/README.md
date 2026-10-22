# 课程文件放在这里

每节课一个文件，格式为 `.md`（Markdown）或 `.txt`。文件名用英文或拼音，例如 `lesson-01.md`。

文件开头可以写课程信息（可选）：

```
---
title: 课程标题
summary: 一句话简介
order: 1
---
正文从这里开始。可以用 ## 小标题、- 列表、**加粗** 等 Markdown 格式。
```

- `title`：课程标题。不写就用文件名。
- `summary`：显示在课程卡片上的简介。
- `order`：课程顺序，数字小的排在前面。

保存后刷新网页即可看到，不需要重启。这个 README 文件不会显示为课程。

英文版放在 `en/` 子文件夹，文件名和中文版相同（例如 `en/lesson-01.md`），这样切换语言时学习进度不会丢。English versions go in the `en/` folder with the same file names.
