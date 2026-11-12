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

保存后刷新网页即可看到，不需要重启。这个 README 文件和 `SOURCES.md` 不会显示为课程。

## 引用资料的写法

课程里的观点可以用提示框注明出处，放在它支持的那段话后面：

```
> **书里怎么说：** 用自己的话概括书中观点，或引用一句短的原话。——作者，*书名*（年份），第 X 章
```

标签可以是“书里怎么说”“研究怎么说”“国际指南怎么说”“法律怎么说”（英文版对应 From the book / What research says / International guidance / What the law says）。外文原句在中文版里注明“（本平台译）”。每节课末尾的“## 参考资料”（英文版“## Sources”）列出完整书目。

每一条引用都要先核对原文，并记录在 `SOURCES.md` 里；核对不了的不写。

英文版放在 `en/` 子文件夹，文件名和中文版相同（例如 `en/lesson-01.md`），这样切换语言时学习进度不会丢。English versions go in the `en/` folder with the same file names.
