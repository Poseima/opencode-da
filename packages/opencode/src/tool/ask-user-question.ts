import z from "zod"
import { Tool } from "./tool"
import { UserQuestion } from "../user-question"
import DESCRIPTION from "./ask-user-question.txt"

const QuestionOption = z.object({
  label: z.string().describe("Succinct summary (1-5 words)"),
  description: z.string().describe("Detailed explanation of this option"),
})

const Question = z.object({
  question: z
    .string()
    .describe(
      "The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: \"Which library should we use for date formatting?\" If multiSelect is true, phrase it accordingly, e.g. \"Which features do you want to enable?\"",
    ),
  header: z
    .string()
    .max(12)
    .describe(
      "Very short label displayed as a chip/tag (max 12 chars). Examples: \"Auth method\", \"Library\", \"Approach\".",
    ),
  options: z
    .array(QuestionOption)
    .min(2)
    .max(4)
    .describe(
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). There should be no 'Other' option, that will be provided automatically.",
    ),
  multiSelect: z
    .boolean()
    .describe(
      "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
    ),
})

export const AskUserQuestionTool = Tool.define("ask_user_question", {
  description: DESCRIPTION,

  parameters: z.object({
    questions: z.array(Question).min(1).max(4).describe("Questions to ask the user (1-4 questions)"),
  }),

  async execute(params, ctx) {
    // Convert to internal format
    const questions: UserQuestion.Question[] = params.questions.map((q) => ({
      question: q.question,
      header: q.header,
      options: q.options.map((o) => ({
        label: o.label,
        description: o.description,
      })),
      multiSelect: q.multiSelect,
    }))

    // Block and wait for user response
    const answers = await UserQuestion.ask({
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID ?? ctx.messageID, // fallback to messageID if callID not available
      questions,
    })

    // Format the output for the LLM
    const output = UserQuestion.formatAnswers(questions, answers)

    // Build metadata for conversation history
    const answersRecord: Record<string, string> = {}
    for (const answer of answers) {
      const question = questions[answer.questionIndex]
      if (!question) continue

      const selectedLabels = answer.selectedIndices
        .map((i) => question.options[i]?.label)
        .filter(Boolean)

      const parts = [...selectedLabels]
      if (answer.customText) {
        parts.push(answer.customText)
      }

      answersRecord[question.question] = parts.join(", ") || "(no selection)"
    }

    return {
      title: answers.length > 0 ? `${answers.length} question(s) answered` : "Questions skipped",
      output,
      metadata: {
        questionCount: questions.length,
        answerCount: answers.length,
        answers: answersRecord,
      },
    }
  },
})
