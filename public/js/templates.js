// Guided writing templates for new notes. `audience`: parent | student | all.
// Bodies are plain prompts (no Markdown symbols) so they read naturally while typing.

export const TEMPLATES = [
  {
    id: "feelings-log",
    audience: "all",
    zh: {
      title: "今天的情绪记录",
      desc: "把一件小事和当时的感受写下来",
      body: "发生了什么：\n\n\n我当时的感受（试着给它起个名字）：\n\n\n身体有什么反应：\n\n\n我当时做了什么：\n\n\n下次我可能会……\n\n",
    },
    en: {
      title: "Today's feelings log",
      desc: "Write down one small event and how you felt",
      body: "What happened:\n\n\nHow I felt (try to give it a name):\n\n\nWhat my body did:\n\n\nWhat I did then:\n\n\nNext time I might...\n\n",
    },
  },
  {
    id: "conflict-review",
    audience: "all",
    zh: {
      title: "一次冲突的回顾",
      desc: "吵完架以后，慢慢理一理",
      body: "起因是什么：\n\n\n我说了什么，对方说了什么：\n\n\n我真正想表达的是：\n\n\n对方可能真正想表达的是：\n\n\n如果重来一次，我想怎么说：\n\n",
    },
    en: {
      title: "Looking back on an argument",
      desc: "After a fight, sort through it slowly",
      body: "How it started:\n\n\nWhat I said, and what they said:\n\n\nWhat I really wanted to say:\n\n\nWhat they may really have wanted to say:\n\n\nIf I could do it again, I would say:\n\n",
    },
  },
  {
    id: "letter-to-parent",
    audience: "student",
    zh: {
      title: "写给父母的一封信",
      desc: "不一定要寄出，先把心里话写下来",
      body: "爸爸 / 妈妈：\n\n我一直想跟你们说……\n\n有一件事让我很难受……\n\n我知道你们其实是关心我，因为……\n\n我希望以后我们可以……\n",
    },
    en: {
      title: "A letter to my parents",
      desc: "You don't have to send it. Just get it written down.",
      body: "Dear Mum / Dad,\n\nI've always wanted to tell you...\n\nSomething that has really upset me is...\n\nI know you actually care about me, because...\n\nI hope that from now on we can...\n",
    },
  },
  {
    id: "letter-to-child",
    audience: "parent",
    zh: {
      title: "写给孩子的一封信",
      desc: "把平时说不出口的话写下来",
      body: "孩子：\n\n我很少跟你说，其实……\n\n有时候我说话很急，是因为我担心……\n\n如果之前让你难过了，我想说……\n\n我希望你知道，不管发生什么……\n",
    },
    en: {
      title: "A letter to my child",
      desc: "Write down what is hard to say out loud",
      body: "Dear ____,\n\nI rarely tell you this, but...\n\nSometimes I speak sharply because I'm worried that...\n\nIf I've upset you before, I want to say...\n\nI want you to know that whatever happens...\n",
    },
  },
  {
    id: "words-i-wished",
    audience: "all",
    zh: {
      title: "我希望听到的话",
      desc: "那些你一直希望有人对你说的话",
      body: "我多希望有人对我说：\n\n\n当时我需要的其实是：\n\n\n现在，我可以对自己说：\n\n",
    },
    en: {
      title: "Words I wish I'd heard",
      desc: "The things you always wished someone would say to you",
      body: "I really wish someone had told me:\n\n\nWhat I actually needed then was:\n\n\nNow I can tell myself:\n\n",
    },
  },
  {
    id: "lesson-notes",
    audience: "all",
    zh: {
      title: "课程学习笔记",
      desc: "记下学到的和想到的",
      body: "我学到了什么：\n\n\n让我想到了自己的哪段经历：\n\n\n我还不明白的问题：\n\n",
    },
    en: {
      title: "Lesson notes",
      desc: "What you learned and what it made you think of",
      body: "What I learned:\n\n\nWhat it reminded me of in my own life:\n\n\nQuestions I still have:\n\n",
    },
  },
];
