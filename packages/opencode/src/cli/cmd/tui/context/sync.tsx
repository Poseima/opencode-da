import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  Permission,
  LspStatus,
  McpStatus,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import type { UserQuestion } from "@/user-question"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount } from "solid-js"
import { Log } from "@/util/log"
import type { Path } from "@opencode-ai/sdk"

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: Permission[]
      }
      userQuestion: {
        [sessionID: string]: UserQuestion.Info[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      userQuestion: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
    })

    const sdk = useSDK()

    sdk.event.listen((e) => {
      const event = e.details as { type: string; properties: any }

      // Handle userquestion events (not in SDK types yet)
      if (event.type === "userquestion.asked") {
        const props = event.properties as UserQuestion.Info
        Log.Default.info("[SYNC] userquestion.asked", { id: props.id, sessionID: props.sessionID, questionsCount: props.questions?.length })
        const questions = store.userQuestion[props.sessionID]
        if (!questions) {
          setStore("userQuestion", props.sessionID, [props])
        } else {
          setStore(
            "userQuestion",
            props.sessionID,
            produce((draft) => {
              draft.push(props)
            }),
          )
        }
        Log.Default.info("[SYNC] after userquestion.asked, store has", { count: store.userQuestion[props.sessionID]?.length })
        return
      }

      if (event.type === "userquestion.answered") {
        const props = event.properties as { id: string; sessionID: string }
        Log.Default.info("[SYNC] userquestion.answered", { id: props.id, sessionID: props.sessionID })
        const questions = store.userQuestion[props.sessionID]
        Log.Default.info("[SYNC] before remove, questions count", { count: questions?.length })
        if (!questions) return
        const match = questions.findIndex((q) => q.id === props.id)
        if (match < 0) return
        setStore(
          "userQuestion",
          props.sessionID,
          produce((draft) => {
            draft.splice(match, 1)
          }),
        )
        Log.Default.info("[SYNC] after remove, questions count", { count: store.userQuestion[props.sessionID]?.length })
        return
      }

      // Type assertion for the switch
      const typedEvent = event as typeof e.details
      switch (typedEvent.type) {
        case "permission.updated": {
          const permissions = store.permission[typedEvent.properties.sessionID]
          if (!permissions) {
            setStore("permission", typedEvent.properties.sessionID, [typedEvent.properties])
            break
          }
          const match = Binary.search(permissions, typedEvent.properties.id, (p) => p.id)
          setStore(
            "permission",
            typedEvent.properties.sessionID,
            produce((draft) => {
              if (match.found) {
                draft[match.index] = typedEvent.properties
                return
              }
              draft.push(typedEvent.properties)
            }),
          )
          break
        }

        case "permission.replied": {
          const permissions = store.permission[typedEvent.properties.sessionID]
          const match = Binary.search(permissions, typedEvent.properties.permissionID, (p) => p.id)
          if (!match.found) break
          setStore(
            "permission",
            typedEvent.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", typedEvent.properties.sessionID, typedEvent.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", typedEvent.properties.sessionID, typedEvent.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, typedEvent.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, typedEvent.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(typedEvent.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, typedEvent.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", typedEvent.properties.sessionID, typedEvent.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[typedEvent.properties.info.sessionID]
          if (!messages) {
            setStore("message", typedEvent.properties.info.sessionID, [typedEvent.properties.info])
            break
          }
          const result = Binary.search(messages, typedEvent.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", typedEvent.properties.info.sessionID, result.index, reconcile(typedEvent.properties.info))
            break
          }
          setStore(
            "message",
            typedEvent.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, typedEvent.properties.info)
              if (draft.length > 100) draft.shift()
            }),
          )
          break
        }
        case "message.removed": {
          const messages = store.message[typedEvent.properties.sessionID]
          const result = Binary.search(messages, typedEvent.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              typedEvent.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[typedEvent.properties.part.messageID]
          if (!parts) {
            setStore("part", typedEvent.properties.part.messageID, [typedEvent.properties.part])
            break
          }
          const result = Binary.search(parts, typedEvent.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", typedEvent.properties.part.messageID, result.index, reconcile(typedEvent.properties.part))
            break
          }
          setStore(
            "part",
            typedEvent.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, typedEvent.properties.part)
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[typedEvent.properties.messageID]
          const result = Binary.search(parts, typedEvent.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              typedEvent.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: typedEvent.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      const sessionListPromise = sdk.client.session.list().then((x) =>
        setStore(
          "session",
          (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)),
        ),
      )

      // blocking - include session.list when continuing a session
      const blockingRequests: Promise<unknown>[] = [
        sdk.client.config.providers({}, { throwOnError: true }).then((x) => {
          batch(() => {
            setStore("provider", x.data!.providers)
            setStore("provider_default", x.data!.default)
          })
        }),
        sdk.client.provider.list({}, { throwOnError: true }).then((x) => {
          batch(() => {
            setStore("provider_next", x.data!)
          })
        }),
        sdk.client.app.agents({}, { throwOnError: true }).then((x) => setStore("agent", x.data ?? [])),
        sdk.client.config.get({}, { throwOnError: true }).then((x) => setStore("config", x.data!)),
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise]),
            sdk.client.command.list().then((x) => setStore("command", x.data ?? [])),
            sdk.client.lsp.status().then((x) => setStore("lsp", x.data!)),
            sdk.client.mcp.status().then((x) => setStore("mcp", x.data!)),
            sdk.client.formatter.status().then((x) => setStore("formatter", x.data!)),
            sdk.client.session.status().then((x) => setStore("session_status", x.data!)),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", x.data ?? {})),
            sdk.client.vcs.get().then((x) => setStore("vcs", x.data)),
            sdk.client.path.get().then((x) => setStore("path", x.data!)),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          await exit(e)
        })
    }

    onMount(() => {
      bootstrap()
    })

    const fullSyncedSessions = new Set<string>()
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              draft.todo[sessionID] = todo.data ?? []
              draft.message[sessionID] = messages.data!.map((x) => x.info)
              for (const message of messages.data!) {
                draft.part[message.info.id] = message.parts
              }
              draft.session_diff[sessionID] = diff.data ?? []
            }),
          )
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
