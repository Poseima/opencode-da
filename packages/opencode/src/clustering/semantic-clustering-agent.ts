/**
 * Semantic Clustering Agent for Data Analysis
 *
 * This module provides a semantic clustering agent that performs clustering and classification
 * in two stages: first clustering on a sample, then classification on the full dataset.
 */

import { generateText } from "ai"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Log } from "../util/log"

const log = Log.create({ service: "semantic-clustering-agent" })

// ==================== Configuration ====================

const CONFIG = {
  sampleRatio: 0.3, // Sample 30% of data for clustering stage
  minSampleThreshold: 200, // Use all if <= 200 items
  batchSize: 20, // Batch size for classification stage
  maxConcurrentBatches: 6, // Concurrency for batch processing
}

// ==================== Types ====================

export interface PreDefinedCategory {
  label: string
  definition?: string
  keywords?: string[]
}

export interface ClusteringResult {
  clusterObjectiveClarification: string
  clusterDefinitions: Record<string, string>
  clusterTaglines: Record<string, number>
  step2ClusterTaglines: Record<string, number>
  taglineClassification: Record<string, string[]>
  usedPreDefinedCategories: boolean
}

interface LLMContext {
  abort: AbortSignal
}

// ==================== Prompts ====================

const CLUSTERING_SYSTEM_PROMPT = `Your primary task is to perform insightful semantic clustering on [interviewee_opinions]

[cluster_objective]='{cluster_objective}'
[additional_requirements]='{additional_requirements}'
[Tone and Wording style]=\`\`\`
*   **Tone and Wording**:
    *   **Professional, Direct, Easy to understand**
    *   **Perfect granularity for cluster analysis**
    *   **Avoid using slash (/) in cluster taglines**
\`\`\`
[Language]=All taglines and definitions must be in CHINESE.

Follow instructions step by step meticulously:
Step 1. Develop insightful, business-oriented, non-overlapping cluster taglines adhering to [clustering_objective], following [Tone and Wording style], ignore [interviewee_opinions] that's not relevant to [clustering_objective], pay hyper attention to [additional_requirements] if its applicable.
Always Add "其他" as one of the cluster to maximize completeness.
The cluster_tagline will later be used to perform classification and analysis, make sure the taglines are meaningful!
Step 2. Identify cluster_taglines that is absolutely not the focus of [cluster_objective]. If all taglines are focus that does not need to be filtered for later analysis , output tagline "其他".

All cluster_tagline_index must be int!

output in following json format:
\`\`\`json
{
"cluster_objective_clarification":"...",
"cluster_definitions": {"{$cluster_tagline}":"{$cluster_detail_definition}", ...},
"cluster_taglines": {"{$cluster_tagline}":"{$cluster_tagline_index}", ...},
"step2_cluster_taglines": {"{$cluster_tagline}":"{$cluster_tagline_index}", ...}
}
\`\`\``

const PREDEFINED_LABELS_SYSTEM_PROMPT = `Your task is to generate DEFINITIONS for the PRE-DEFINED labels provided by user.

[pre_defined_labels]={predefined_labels}
[cluster_objective]='{cluster_objective}'
[additional_requirements]='{additional_requirements}'
[Tone and Wording style]=\`\`\`
*   **Tone and Wording**:
    *   **Professional, Direct, Easy to understand**
    *   **Perfect granularity for cluster analysis**
\`\`\`
[Language]=All definitions must be in CHINESE.

CRITICAL INSTRUCTIONS:
1. You MUST use the EXACT label names provided in [pre_defined_labels]. DO NOT modify, rename, or create new labels!
2. Your job is ONLY to generate clear, detailed definitions for each pre-defined label based on the sample data.
3. The definition should explain what kind of data/opinions belong to each label.
4. Always include "其他" category for data that doesn't fit any pre-defined label.

All cluster_tagline_index must be int!

output in following json format:
\`\`\`json
{
"cluster_objective_clarification":"...",
"cluster_definitions": {"{$exact_predefined_label}":"{$generated_definition}", ...},
"cluster_taglines": {"{$exact_predefined_label}":"{$cluster_tagline_index}", ...},
"step2_cluster_taglines": {"其他": {$last_index}}
}
\`\`\``

const CLASSIFICATION_SYSTEM_PROMPT = `Your primary task is to perform accurate tagline classification on [interviewee_opinions]

[cluster_objective]='{cluster_objective}'
[additional_requirements]='{additional_requirements}'
[cluster_definitions]='{cluster_definitions}'
[cluster_taglines]='{cluster_taglines}'
[Language]=All taglines and definitions must be in CHINESE.

Follow instructions step by step meticulously:
Step 1. Use the provided cluster taglines and definitions for classification, ignore [interviewee_opinions] that's not relevant to [clustering_objective], pay hyper attention to [additional_requirements] if its applicable.
Step 2. Classify [interviewee_opinions] into cluster taglines strictly adhering to [cluster_definitions], an interviewee opinion can be classified into multiple cluster taglines. Output "其他" if [interviewee_opinions] can not be accurately classified to any cluster taglines.

Hyper attention:
You must only output corresponding index in interviewee opinion!
You must only output corresponding index in cluster tagline!
Your classification must strictly follow the cluster definitions!
The cluster_tagline_index must be int!

output in following json format:
\`\`\`json
{
"cluster_objective_clarification":"...",
"tagline_classification":{"{$interviewee_opinion_index}":["{$cluster_tagline_index}", ...],...}
}
\`\`\`
Note that in "tagline_classification", the key is the index of the interviewee opinion, and the value is a list of cluster tagline indices. All interviewee opinion must be covered.`

// ==================== Main Class ====================

export class SemanticClusteringAgent {
  /**
   * Main processing method for semantic clustering and classification.
   */
  async processClustering(
    clusterInput: Record<number, string>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    preDefinedCategories: PreDefinedCategory[] | undefined,
    ctx: LLMContext,
  ): Promise<ClusteringResult> {
    try {
      let clusterDefinitions: Record<string, string>
      let clusterTaglines: Record<string, number>
      let step2ClusterTaglines: Record<string, number>

      // Stage 1: Clustering
      if (preDefinedCategories && preDefinedCategories.length > 0) {
        // Check if all categories have valid definitions
        const hasDefinitions = preDefinedCategories.every(
          (cat) => cat.definition && cat.definition !== "未提供",
        )

        if (hasDefinitions) {
          // User provided both labels AND definitions - skip Stage 1
          log.info("Using pre-defined categories with definitions, skipping Stage 1", {
            count: preDefinedCategories.length,
          })

          clusterDefinitions = {}
          clusterTaglines = {}

          for (let idx = 0; idx < preDefinedCategories.length; idx++) {
            const cat = preDefinedCategories[idx]
            const label = cat.label || `类别${idx + 1}`
            const definition = cat.definition || label
            clusterDefinitions[label] = definition
            clusterTaglines[label] = idx
          }

          // Add "其他" category
          if (!clusterTaglines["其他"]) {
            const otherIdx = Object.keys(clusterTaglines).length
            clusterTaglines["其他"] = otherIdx
            clusterDefinitions["其他"] = "不属于任何预定义类别的回答"
          }

          step2ClusterTaglines = {}
        } else {
          // User provided only labels - run Stage 1 to generate definitions
          log.info("User provided labels without definitions, running Stage 1 to generate definitions")
          const predefinedLabels = preDefinedCategories
            .map((cat) => cat.label)
            .filter((label): label is string => !!label)
          ;({ clusterDefinitions, clusterTaglines, step2ClusterTaglines } =
            await this.performClusteringWithPredefinedLabels(
              clusterInput,
              clusterObjective,
              additionalRequirements,
              predefinedLabels,
              ctx,
            ))
        }
      } else {
        log.info("Stage 1: Performing clustering on sample data")
        ;({ clusterDefinitions, clusterTaglines, step2ClusterTaglines } = await this.performClustering(
          clusterInput,
          clusterObjective,
          additionalRequirements,
          ctx,
        ))
      }

      // Combine cluster_taglines and step2_cluster_taglines for classification
      const allClusterTaglines = { ...clusterTaglines, ...step2ClusterTaglines }
      log.info("Combined taglines for classification", {
        total: Object.keys(allClusterTaglines).length,
      })

      // Stage 2: Classification
      log.info("Stage 2: Performing classification on full dataset")
      const taglineClassification = await this.performClassification(
        clusterInput,
        clusterDefinitions,
        allClusterTaglines,
        clusterObjective,
        additionalRequirements,
        ctx,
      )

      // Filter out data classified to step2_cluster_taglines or "其他"
      const filteredClassification: Record<string, string[]> = {}
      const step2TaglineIndices = new Set(Object.values(step2ClusterTaglines).map(String))
      const otherTaglineIndices = new Set<string>()

      // Find "其他" tagline indices
      for (const [tagline, idx] of Object.entries(allClusterTaglines)) {
        if (tagline === "其他") {
          otherTaglineIndices.add(String(idx))
        }
      }

      const filterIndices = new Set([...step2TaglineIndices, ...otherTaglineIndices])

      for (const [opinionIdx, assignedTaglines] of Object.entries(taglineClassification)) {
        // Normalize to array
        let taglines: string[]
        if (Array.isArray(assignedTaglines)) {
          taglines = assignedTaglines.map(String)
        } else {
          taglines = [String(assignedTaglines)]
        }

        // Remove filtered taglines
        const filteredTaglines = taglines.filter((tag) => !filterIndices.has(tag))

        if (filteredTaglines.length > 0) {
          filteredClassification[opinionIdx] = filteredTaglines
        } else {
          // Keep original if all were filtered
          filteredClassification[opinionIdx] = taglines
        }
      }

      log.info("Filtered classification", {
        remaining: Object.keys(filteredClassification).length,
        original: Object.keys(taglineClassification).length,
      })

      return {
        clusterObjectiveClarification: `基于'${clusterObjective}'进行语义聚类和分类`,
        clusterDefinitions,
        clusterTaglines,
        step2ClusterTaglines,
        taglineClassification: filteredClassification,
        usedPreDefinedCategories: preDefinedCategories !== undefined && preDefinedCategories.length > 0,
      }
    } catch (error) {
      log.error("Error in processClustering", { error })
      throw error
    }
  }

  /**
   * Stage 1: Perform clustering on a sample of the data.
   */
  private async performClustering(
    clusterInput: Record<number, string>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    ctx: LLMContext,
  ): Promise<{
    clusterDefinitions: Record<string, string>
    clusterTaglines: Record<string, number>
    step2ClusterTaglines: Record<string, number>
  }> {
    // Sample data for clustering
    const inputSize = Object.keys(clusterInput).length
    let sampleData: Record<number, string>

    if (inputSize <= CONFIG.minSampleThreshold) {
      sampleData = clusterInput
      log.info(`Using all ${inputSize} items for clustering (data size <= ${CONFIG.minSampleThreshold})`)
    } else {
      const sampleSize = Math.max(1, Math.floor(inputSize * CONFIG.sampleRatio))
      const allIndices = Object.keys(clusterInput).map(Number)
      const sampleIndices = this.randomSample(allIndices, sampleSize)
      sampleData = {}
      for (const idx of sampleIndices) {
        sampleData[idx] = clusterInput[idx]
      }
      log.info(
        `Clustering on ${Object.keys(sampleData).length} sampled items (${CONFIG.sampleRatio * 100}% of ${inputSize})`,
      )
    }

    // Prepare prompt
    const systemPrompt = CLUSTERING_SYSTEM_PROMPT.replace("{cluster_objective}", clusterObjective).replace(
      "{additional_requirements}",
      additionalRequirements || "",
    )

    const userMessage = `[interviewee_opinions]=${JSON.stringify(sampleData)}`

    // Call LLM
    const response = await this.callLLM(systemPrompt, userMessage, ctx)

    // Parse response
    const result = this.parseJSONResponse(response)

    return {
      clusterDefinitions: (result.cluster_definitions || {}) as Record<string, string>,
      clusterTaglines: (result.cluster_taglines || {}) as Record<string, number>,
      step2ClusterTaglines: (result.step2_cluster_taglines || {}) as Record<string, number>,
    }
  }

  /**
   * Stage 1 variant: Generate definitions for user-provided labels.
   */
  private async performClusteringWithPredefinedLabels(
    clusterInput: Record<number, string>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    predefinedLabels: string[],
    ctx: LLMContext,
  ): Promise<{
    clusterDefinitions: Record<string, string>
    clusterTaglines: Record<string, number>
    step2ClusterTaglines: Record<string, number>
  }> {
    // Sample data
    const inputSize = Object.keys(clusterInput).length
    let sampleData: Record<number, string>

    if (inputSize <= CONFIG.minSampleThreshold) {
      sampleData = clusterInput
    } else {
      const sampleSize = Math.max(1, Math.floor(inputSize * CONFIG.sampleRatio))
      const allIndices = Object.keys(clusterInput).map(Number)
      const sampleIndices = this.randomSample(allIndices, sampleSize)
      sampleData = {}
      for (const idx of sampleIndices) {
        sampleData[idx] = clusterInput[idx]
      }
    }

    // Prepare prompt
    const systemPrompt = PREDEFINED_LABELS_SYSTEM_PROMPT.replace(
      "{predefined_labels}",
      JSON.stringify(predefinedLabels),
    )
      .replace("{cluster_objective}", clusterObjective)
      .replace("{additional_requirements}", additionalRequirements || "")

    const userMessage = `[interviewee_opinions]=${JSON.stringify(sampleData)}`

    // Call LLM
    const response = await this.callLLM(systemPrompt, userMessage, ctx)

    // Parse response
    const result = this.parseJSONResponse(response)

    let clusterDefinitions: Record<string, string> = (result.cluster_definitions || {}) as Record<string, string>
    let clusterTaglines: Record<string, number> = (result.cluster_taglines || {}) as Record<string, number>
    let step2ClusterTaglines: Record<string, number> = (result.step2_cluster_taglines || {}) as Record<string, number>

    // Ensure all predefined labels are included
    for (const label of predefinedLabels) {
      if (!(label in clusterTaglines)) {
        const nextIdx =
          Math.max(...Object.values(clusterTaglines).map(Number), -1) + 1
        clusterTaglines[label] = nextIdx
        clusterDefinitions[label] = label
      }
    }

    // Ensure "其他" is included
    if (!("其他" in clusterTaglines) && !("其他" in step2ClusterTaglines)) {
      const allValues = [
        ...Object.values(clusterTaglines).map(Number),
        ...Object.values(step2ClusterTaglines).map(Number),
      ]
      const otherIdx = Math.max(...allValues, -1) + 1
      step2ClusterTaglines["其他"] = otherIdx
      clusterDefinitions["其他"] = "不属于任何预定义类别的回答"
    }

    return { clusterDefinitions, clusterTaglines, step2ClusterTaglines }
  }

  /**
   * Stage 2: Perform classification on the full dataset using concurrent batch processing.
   */
  private async performClassification(
    clusterInput: Record<number, string>,
    clusterDefinitions: Record<string, string>,
    clusterTaglines: Record<string, number>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    ctx: LLMContext,
  ): Promise<Record<string, string[]>> {
    // Create batches
    const items = Object.entries(clusterInput)
    const batches: Array<{ batch: Record<number, string>; batchNum: number }> = []

    for (let i = 0; i < items.length; i += CONFIG.batchSize) {
      const batchItems = items.slice(i, i + CONFIG.batchSize)
      const batch: Record<number, string> = {}
      for (const [idx, text] of batchItems) {
        batch[Number(idx)] = text
      }
      batches.push({ batch, batchNum: batches.length + 1 })
    }

    const totalBatches = batches.length
    log.info(`Processing ${items.length} items in ${totalBatches} batches with concurrency ${CONFIG.maxConcurrentBatches}`)

    // Process batches concurrently
    const allClassifications: Record<string, string[]> = {}

    for (let i = 0; i < batches.length; i += CONFIG.maxConcurrentBatches) {
      const chunk = batches.slice(i, i + CONFIG.maxConcurrentBatches)
      const promises = chunk.map(({ batch, batchNum }) =>
        this.classifyBatch(
          batch,
          clusterDefinitions,
          clusterTaglines,
          clusterObjective,
          additionalRequirements || "",
          ctx,
          batchNum,
          totalBatches,
        ),
      )

      const results = await Promise.all(promises)
      for (const result of results) {
        Object.assign(allClassifications, result)
      }
    }

    log.info(`Classification completed for ${Object.keys(allClassifications).length} items`)
    return allClassifications
  }

  /**
   * Classify a single batch of data.
   */
  private async classifyBatch(
    batch: Record<number, string>,
    clusterDefinitions: Record<string, string>,
    clusterTaglines: Record<string, number>,
    clusterObjective: string,
    additionalRequirements: string,
    ctx: LLMContext,
    batchNum: number,
    totalBatches: number,
  ): Promise<Record<string, string[]>> {
    log.info(`Processing batch ${batchNum}/${totalBatches} with ${Object.keys(batch).length} items`)

    try {
      // Prepare prompt
      const systemPrompt = CLASSIFICATION_SYSTEM_PROMPT.replace("{cluster_objective}", clusterObjective)
        .replace("{additional_requirements}", additionalRequirements)
        .replace("{cluster_definitions}", JSON.stringify(clusterDefinitions))
        .replace("{cluster_taglines}", JSON.stringify(clusterTaglines))

      const userMessage = `[interviewee_opinions]=${JSON.stringify(batch)}`

      // Call LLM
      const response = await this.callLLM(systemPrompt, userMessage, ctx)

      // Parse response
      const result = this.parseJSONResponse(response)
      const taglineClassification = result.tagline_classification || {}

      // Normalize: ensure all values are arrays
      const normalized: Record<string, string[]> = {}
      for (const [opinionIdx, assignedTaglines] of Object.entries(taglineClassification)) {
        if (Array.isArray(assignedTaglines)) {
          normalized[opinionIdx] = assignedTaglines.map(String)
        } else {
          normalized[opinionIdx] = [String(assignedTaglines)]
        }
      }

      return normalized
    } catch (error) {
      log.error(`Error in batch ${batchNum} classification`, { error })
      return {}
    }
  }

  // ==================== Helper Methods ====================

  private async callLLM(system: string, prompt: string, ctx: LLMContext): Promise<string> {
    const cfg = await Config.get()
    let model: Provider.Model

    // Use semantic_clustering_model from config, fallback to llm_tool_model, then small model
    if (cfg.semantic_clustering_model) {
      const parsed = Provider.parseModel(cfg.semantic_clustering_model)
      model = await Provider.getModel(parsed.providerID, parsed.modelID)
    } else if (cfg.llm_tool_model) {
      const parsed = Provider.parseModel(cfg.llm_tool_model)
      model = await Provider.getModel(parsed.providerID, parsed.modelID)
    } else {
      const smallModel = await Provider.getSmallModel("opencode")
      if (smallModel) {
        model = smallModel
      } else {
        const defaultModel = await Provider.defaultModel()
        model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
      }
    }

    const language = await Provider.getLanguage(model)

    const result = await generateText({
      model: language,
      system,
      prompt,
      abortSignal: ctx.abort,
    })

    return result.text
  }

  private parseJSONResponse(response: string): Record<string, unknown> {
    let content = response.trim()

    // Extract JSON from markdown code blocks
    if (content.includes("```json")) {
      content = content.split("```json")[1].split("```")[0]
    } else if (content.includes("```")) {
      content = content.split("```")[1].split("```")[0]
    }

    try {
      return JSON.parse(content)
    } catch (error) {
      log.error("Failed to parse JSON response", { response: content.slice(0, 500), error })
      throw new Error(`Failed to parse LLM response as JSON: ${error}`)
    }
  }

  private randomSample<T>(array: T[], sampleSize: number): T[] {
    const shuffled = [...array]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    return shuffled.slice(0, sampleSize)
  }
}
