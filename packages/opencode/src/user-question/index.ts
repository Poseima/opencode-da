import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import z from "zod"
import { Log } from "../util/log"
import { Identifier } from "../id/id"
import { Instance } from "../project/instance"

export namespace UserQuestion {
  const log = Log.create({ service: "user-question" })

  export const QuestionOption = z.object({
    label: z.string(),
    description: z.string(),
  })
  export type QuestionOption = z.infer<typeof QuestionOption>

  export const Question = z.object({
    question: z.string(),
    header: z.string(),
    options: z.array(QuestionOption),
    multiSelect: z.boolean(),
  })
  export type Question = z.infer<typeof Question>

  export const Answer = z.object({
    questionIndex: z.number(),
    selectedIndices: z.array(z.number()),
    customText: z.string().nullable(),
  })
  export type Answer = z.infer<typeof Answer>

  export const Info = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
    callID: z.string(),
    questions: z.array(Question),
    time: z.object({
      created: z.number(),
    }),
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Asked: BusEvent.define("userquestion.asked", Info),
    Answered: BusEvent.define(
      "userquestion.answered",
      z.object({
        id: z.string(),
        sessionID: z.string(),
        answers: z.array(Answer),
      }),
    ),
  }

  const state = Instance.state(
    () => {
      const pending: {
        [sessionID: string]: {
          [questionID: string]: {
            info: Info
            resolve: (answers: Answer[]) => void
            reject: (e: any) => void
          }
        }
      } = {}

      return { pending }
    },
    async (state) => {
      // On dispose, resolve all pending with empty answers
      for (const pending of Object.values(state.pending)) {
        for (const item of Object.values(pending)) {
          item.resolve([])
        }
      }
    },
  )

  export function pending() {
    return state().pending
  }

  export async function ask(input: {
    sessionID: string
    messageID: string
    callID: string
    questions: Question[]
  }): Promise<Answer[]> {
    const { pending } = state()

    log.info("asking questions", {
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      questionCount: input.questions.length,
    })

    const info: Info = {
      id: Identifier.ascending("userquestion"),
      sessionID: input.sessionID,
      messageID: input.messageID,
      callID: input.callID,
      questions: input.questions,
      time: {
        created: Date.now(),
      },
    }

    pending[input.sessionID] = pending[input.sessionID] || {}

    return new Promise<Answer[]>((resolve, reject) => {
      pending[input.sessionID][info.id] = {
        info,
        resolve,
        reject,
      }
      Bus.publish(Event.Asked, info)
    })
  }

  export function respond(input: { id: string; sessionID: string; answers: Answer[] }) {
    log.info("response received", {
      id: input.id,
      sessionID: input.sessionID,
      answerCount: input.answers.length,
    })

    const { pending } = state()
    const match = pending[input.sessionID]?.[input.id]
    if (!match) {
      log.warn("no pending question found", { id: input.id, sessionID: input.sessionID })
      return
    }

    delete pending[input.sessionID][input.id]

    Bus.publish(Event.Answered, {
      id: input.id,
      sessionID: input.sessionID,
      answers: input.answers,
    })

    match.resolve(input.answers)
  }

  export function cancel(input: { id: string; sessionID: string }) {
    log.info("cancelled", { id: input.id, sessionID: input.sessionID })

    const { pending } = state()
    const match = pending[input.sessionID]?.[input.id]
    if (!match) return

    delete pending[input.sessionID][input.id]

    // Emit event to notify TUI that the question was cancelled
    Bus.publish(Event.Answered, {
      id: input.id,
      sessionID: input.sessionID,
      answers: [],
    })

    // Return empty answers instead of rejecting - LLM decides how to proceed
    match.resolve([])
  }

  export function formatAnswers(questions: Question[], answers: Answer[]): string {
    if (answers.length === 0) {
      return "User cancelled or skipped all questions."
    }

    const lines: string[] = []

    for (const answer of answers) {
      const question = questions[answer.questionIndex]
      if (!question) continue

      lines.push(`## ${question.header}: ${question.question}`)

      const selectedLabels = answer.selectedIndices
        .map((i) => question.options[i]?.label)
        .filter(Boolean)

      if (selectedLabels.length > 0 || answer.customText) {
        const parts = [...selectedLabels]
        if (answer.customText) {
          parts.push(`Custom: "${answer.customText}"`)
        }
        lines.push(`**Answer:** ${parts.join(", ")}`)
      } else {
        lines.push(`**Answer:** (no selection)`)
      }

      lines.push("")
    }

    return lines.join("\n")
  }
}
