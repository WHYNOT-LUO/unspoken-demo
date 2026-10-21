// Guided writing templates for new notes. `audience`: parent | student | all.

export const TEMPLATES = [
  {
    id: "feelings-log",
    title: "今天的情绪记录",
    desc: "把一件小事和当时的感受写下来",
    audience: "all",
    body: `## 发生了什么

## 我当时的感受（试着给它起个名字）

## 身体有什么反应

## 我当时做了什么

## 下次我可能会……
`,
  },
  {
    id: "conflict-review",
    title: "一次冲突的回顾",
    desc: "吵完架以后，慢慢理一理",
    audience: "all",
    body: `## 起因是什么

## 我说了什么，对方说了什么

## 我真正想表达的是

## 对方可能真正想表达的是

## 如果重来一次，我想怎么说
`,
  },
  {
    id: "letter-to-parent",
    title: "写给父母的一封信",
    desc: "不一定要寄出，先把心里话写下来",
    audience: "student",
    body: `爸爸 / 妈妈：

我一直想跟你们说……

有一件事让我很难受……

我知道你们其实是关心我，因为……

我希望以后我们可以……
`,
  },
  {
    id: "letter-to-child",
    title: "写给孩子的一封信",
    desc: "把平时说不出口的话写下来",
    audience: "parent",
    body: `孩子：

我很少跟你说，其实……

有时候我说话很急，是因为我担心……

如果之前让你难过了，我想说……

我希望你知道，不管发生什么……
`,
  },
  {
    id: "words-i-wished",
    title: "我希望听到的话",
    desc: "那些你一直希望有人对你说的话",
    audience: "all",
    body: `## 我多希望有人对我说

## 当时我需要的其实是

## 现在，我可以对自己说
`,
  },
  {
    id: "lesson-notes",
    title: "课程学习笔记",
    desc: "记下学到的和想到的",
    audience: "all",
    body: `## 我学到了什么

## 让我想到了自己的哪段经历

## 我还不明白的问题
`,
  },
];
