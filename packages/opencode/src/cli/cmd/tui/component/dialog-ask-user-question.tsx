import { createSignal, createMemo, For, Show, createEffect, on } from "solid-js"
import { useTheme } from "@tui/context/theme"
import { useKeyboard } from "@opentui/solid"
import { useDialog } from "@tui/ui/dialog"
import { TextAttributes } from "@opentui/core"
import type { UserQuestion } from "@/user-question"

interface Props {
  id: string
  sessionID: string
  questions: UserQuestion.Question[]
  onSubmit: (answers: UserQuestion.Answer[]) => void
  onCancel: () => void
}

export function DialogAskUserQuestion(props: Props) {
  const { theme } = useTheme()
  const dialog = useDialog()

  const [currentTab, setCurrentTab] = createSignal(0)
  const [answers, setAnswers] = createSignal<Record<number, UserQuestion.Answer>>({})
  const [focusedOption, setFocusedOption] = createSignal(0)
  const [customText, setCustomText] = createSignal("")
  const [isTypingCustom, setIsTypingCustom] = createSignal(false)

  const totalTabs = createMemo(() => props.questions.length + 1) // +1 for submit tab
  const isSubmitTab = createMemo(() => currentTab() === props.questions.length)
  const currentQuestion = createMemo(() => props.questions[currentTab()])

  // Options include the predefined ones + "Type something" as last
  const allOptions = createMemo(() => {
    const q = currentQuestion()
    if (!q) return []
    return [
      ...q.options.map((o, i) => ({ ...o, index: i, isCustom: false })),
      { label: "Type something.", description: "Next", index: q.options.length, isCustom: true },
    ]
  })

  const currentAnswer = createMemo(() => answers()[currentTab()])

  // Reset focus when changing tabs
  createEffect(
    on(
      () => currentTab(),
      () => {
        setFocusedOption(0)
        setIsTypingCustom(false)
        const answer = answers()[currentTab()]
        setCustomText(answer?.customText || "")
      },
    ),
  )

  function isSelected(optionIndex: number): boolean {
    const answer = currentAnswer()
    if (!answer) return false
    return answer.selectedIndices.includes(optionIndex)
  }

  function toggleOption(optionIndex: number) {
    const q = currentQuestion()
    if (!q) return

    const current = currentAnswer() || {
      questionIndex: currentTab(),
      selectedIndices: [],
      customText: null,
    }

    let newIndices: number[]
    if (q.multiSelect) {
      // Toggle in multi-select mode
      if (current.selectedIndices.includes(optionIndex)) {
        newIndices = current.selectedIndices.filter((i) => i !== optionIndex)
      } else {
        newIndices = [...current.selectedIndices, optionIndex]
      }
    } else {
      // Single select - replace
      newIndices = [optionIndex]
    }

    setAnswers((prev) => ({
      ...prev,
      [currentTab()]: {
        ...current,
        selectedIndices: newIndices,
      },
    }))
  }

  function updateCustomText(text: string) {
    setCustomText(text)
    const current = currentAnswer() || {
      questionIndex: currentTab(),
      selectedIndices: [],
      customText: null,
    }
    setAnswers((prev) => ({
      ...prev,
      [currentTab()]: {
        ...current,
        customText: text || null,
      },
    }))
  }

  function moveTab(direction: number) {
    let next = currentTab() + direction
    if (next < 0) next = 0
    if (next >= totalTabs()) next = totalTabs() - 1
    setCurrentTab(next)
  }

  function moveOption(direction: number) {
    const opts = allOptions()
    let next = focusedOption() + direction
    if (next < 0) next = opts.length - 1
    if (next >= opts.length) next = 0
    setFocusedOption(next)
    setIsTypingCustom(false)
  }

  function handleSubmit() {
    const answerList = Object.values(answers())
    props.onSubmit(answerList)
    dialog.clear()
  }

  function handleCancel() {
    props.onCancel()
    dialog.clear()
  }

  function answeredCount() {
    return Object.keys(answers()).length
  }

  function getAnswerSummary(questionIndex: number): string {
    const answer = answers()[questionIndex]
    if (!answer) return "(not answered)"

    const q = props.questions[questionIndex]
    const labels = answer.selectedIndices.map((i) => q.options[i]?.label).filter(Boolean)

    const parts = [...labels]
    if (answer.customText) {
      parts.push(answer.customText)
    }

    return parts.length > 0 ? parts.join(", ") : "(no selection)"
  }

  useKeyboard((evt) => {
    if (isTypingCustom()) {
      // Handle text input mode
      if (evt.name === "escape") {
        setIsTypingCustom(false)
        return
      }
      if (evt.name === "return") {
        setIsTypingCustom(false)
        moveTab(1) // Move to next question
        return
      }
      if (evt.name === "backspace") {
        setCustomText((prev) => prev.slice(0, -1))
        updateCustomText(customText().slice(0, -1))
        return
      }
      if (evt.sequence && evt.sequence.length === 1 && !evt.ctrl && !evt.meta) {
        const newText = customText() + evt.sequence
        setCustomText(newText)
        updateCustomText(newText)
        return
      }
      return
    }

    // Normal navigation mode
    if (evt.name === "escape") {
      handleCancel()
      return
    }

    if (evt.name === "tab" || evt.name === "right") {
      moveTab(1)
      return
    }

    if (evt.shift && evt.name === "tab") {
      moveTab(-1)
      return
    }

    if (evt.name === "left") {
      moveTab(-1)
      return
    }

    if (evt.name === "up" || (evt.ctrl && evt.name === "p")) {
      if (!isSubmitTab()) moveOption(-1)
      return
    }

    if (evt.name === "down" || (evt.ctrl && evt.name === "n")) {
      if (!isSubmitTab()) moveOption(1)
      return
    }

    if (evt.name === "return") {
      if (isSubmitTab()) {
        handleSubmit()
        return
      }

      const opt = allOptions()[focusedOption()]
      if (opt?.isCustom) {
        setIsTypingCustom(true)
        return
      }

      toggleOption(focusedOption())

      // In single select, auto-advance to next question
      if (!currentQuestion()?.multiSelect) {
        moveTab(1)
      }
      return
    }

    if (evt.name === "space" && !isSubmitTab()) {
      const opt = allOptions()[focusedOption()]
      if (opt?.isCustom) {
        setIsTypingCustom(true)
        return
      }
      toggleOption(focusedOption())
      return
    }
  })

  // Helper to get tab label
  function getTabLabel(q: UserQuestion.Question, index: number): string {
    const icon = answers()[index] ? "☒" : "□"
    return `${icon} ${q.header} `
  }

  return (
    <box flexDirection="column" padding={1}>
      {/* Tab Bar */}
      <box flexDirection="row" marginBottom={1}>
        <text fg={theme.textMuted}>{"← "}</text>
        <For each={props.questions}>
          {(q, i) => (
            <text
              fg={currentTab() === i() ? theme.text : theme.textMuted}
              bg={currentTab() === i() ? theme.primary : undefined}
              attributes={currentTab() === i() ? TextAttributes.BOLD : undefined}
            >
              {getTabLabel(q, i())}
            </text>
          )}
        </For>
        <text
          fg={isSubmitTab() ? theme.text : theme.textMuted}
          bg={isSubmitTab() ? theme.primary : undefined}
          attributes={isSubmitTab() ? TextAttributes.BOLD : undefined}
        >
          {"✓ Submit"}
        </text>
        <text fg={theme.textMuted}>{" →"}</text>
      </box>

      {/* Content Area */}
      <Show
        when={!isSubmitTab()}
        fallback={
          /* Submit Tab */
          <box flexDirection="column">
            <text fg={theme.text} attributes={TextAttributes.BOLD}>
              {"Review your answers"}
            </text>
            <box height={1} />

            <Show when={answeredCount() < props.questions.length}>
              <text fg={theme.warning}>{"⚠ You have not answered all questions"}</text>
              <box height={1} />
            </Show>

            <For each={props.questions}>
              {(q, i) => (
                <box flexDirection="column" marginBottom={1}>
                  <text fg={theme.text}>{`● ${q.question}`}</text>
                  <text fg={theme.textMuted}>{`  → ${getAnswerSummary(i())}`}</text>
                </box>
              )}
            </For>

            <box height={1} />
            <text fg={theme.text}>{"Ready to submit your answers?"}</text>
            <box height={1} />

            <box flexDirection="column">
              <text fg={theme.success}>{"› 1. Submit answers"}</text>
              <text fg={theme.textMuted}>{"  2. Cancel (Esc)"}</text>
            </box>
          </box>
        }
      >
        {/* Question View */}
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            {currentQuestion()?.question}
          </text>
          <box height={1} />

          <For each={allOptions()}>
            {(opt, i) => {
              const isFocused = () => focusedOption() === i()
              const isChecked = () => (opt.isCustom ? !!customText() : isSelected(opt.index))
              const multiSelect = () => currentQuestion()?.multiSelect

              // Build prefix string
              const getPrefix = () => {
                const cursor = isFocused() ? "› " : "  "
                if (multiSelect()) {
                  const check = isChecked() ? "[✓] " : "[ ] "
                  return cursor + check
                }
                return `${cursor}${i() + 1}. `
              }

              // Build label string
              const getLabel = () => {
                if (opt.isCustom && isTypingCustom()) {
                  return customText() + "▊"
                }
                if (opt.isCustom && customText()) {
                  return customText()
                }
                return opt.label
              }

              return (
                <box flexDirection="column" marginBottom={0}>
                  <box flexDirection="row">
                    <text fg={isFocused() ? theme.accent : theme.textMuted}>{getPrefix()}</text>
                    <text
                      fg={opt.isCustom && isTypingCustom() ? theme.accent : isFocused() ? theme.accent : theme.text}
                      attributes={isFocused() ? TextAttributes.BOLD : undefined}
                    >
                      {getLabel()}
                    </text>
                  </box>
                  <text fg={theme.textMuted}>{`     ${opt.description}`}</text>
                </box>
              )
            }}
          </For>
        </box>
      </Show>

      {/* Footer */}
      <box height={1} />
      <text fg={theme.textMuted}>{"Enter to select · Tab/Arrow keys to navigate · Esc to cancel"}</text>
    </box>
  )
}
