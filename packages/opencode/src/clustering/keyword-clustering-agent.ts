/**
 * Keyword-Based Clustering Agent for Data Analysis
 *
 * This module provides a keyword-based clustering agent that generates comprehensive
 * keyword mapping configurations using LLM, then performs fast TypeScript-based multi-label
 * assignment for large-scale data standardization.
 */

import { generateText } from "ai"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Log } from "../util/log"

const log = Log.create({ service: "keyword-clustering-agent" })

// ==================== Configuration ====================

const CONFIG = {
  sampleRatio: 0.3, // Sample 30% of data for keyword generation
  minSampleThreshold: 100, // Use all if <= 100 items
  minUnmatchedForIteration: 10, // Stop if < 10 unmatched
}

// ==================== Types ====================

export interface PreDefinedCategory {
  label: string
  definition?: string
  keywords?: string[]
}

export interface KeywordData {
  basicKeywords: string[]
  extrapolateKeywords: string[]
}

export interface KeywordConfig {
  [labelName: string]: KeywordData
}

export interface IterationStats {
  iteration: number
  coverageRate: number
  uniqueLabels: number
  totalItems: number
  otherCount: number
  multiLabelCount: number
}

export interface KeywordClusteringResult {
  clusterObjectiveClarification: string
  keywordConfig: KeywordConfig
  labelAssignments: Record<string, string[]>
  coverageRate: number
  iterationsPerformed: number
  iterationHistory: IterationStats[]
  targetCoverage: number
  targetAchieved: boolean
  usedPreDefinedCategories: boolean
}

interface SupplementaryConfig {
  analysis?: string
  labelExtensions: Record<string, KeywordData>
  newLabels: Record<string, KeywordData>
}

interface LLMContext {
  abort: AbortSignal
}

// ==================== Prompts ====================

const KEYWORD_CONFIG_SYSTEM_PROMPT = `Your primary task is to generate a comprehensive keyword mapping configuration for data standardization. The generated keyword must cover over 90% of the patterns in [input data].

[label_objective]='{cluster_objective}'
[additional_requirements]='{additional_requirements}'
[Tone and Wording style]=\`\`\`
*   **Professional, Direct, Easy to understand**
*   **Focus on generating comprehensive and non-overlapping LABELS (not clusters) for data standardization**
*   **Labels should be designed for QUANTITATIVE ANALYSIS purposes**
*   **Label granularity should match the analysis objective - not too broad, not too fragmented**
*   **Each label should be meaningful and representative, suitable for statistical reporting**
*   **Avoid creating too many niche labels that would have very low frequency**
*   **Keywords should be precise and minimal**
*   **Label naming convention: Labels should be clean and coherent - avoid special characters like '/', '_', '&', '+' in label names. Use spaces or natural language instead.**
\`\`\`
[Language]=All labels and keywords should adapt the same language as [label_objective].

Follow instructions step by step meticulously:
Step 1. Analyze [input_data] based on [label_objective], generate non-overlapping and comprehensive LABELS (emphasize: labels for standardization, not semantic clusters).
Step 1.5. Apply label design principles for quantitative analysis:
   - Granularity: Labels should be at an appropriate level of detail for the analysis objective.
   - Meaningfulness: Each label should represent a distinct, interpretable category.
   - Representativeness: Labels should capture the major patterns in data.
   - Balance: Aim for a balanced distribution where possible.
Step 2. For each label, generate an orthogonal list of precise keywords that comprehensively cover the most essential terms. Leveraging you extensive knowledge base to extrapolate as well, develop keywords that are not in [input_data]!
You must avoid redundancy for Substring Matching, as the keywords will be applied in regex substring matching. For example, when you have 'AA' as keyword, it's meaningless to also include 'AABB' as keyword!
Step 3. Ensure there is none overlapping between labels. Ensure keywords are precise and unambiguous to enable accurate matching.
Step 4. Pay attention to [additional_requirements] if applicable.

IMPORTANT: The keyword configuration will be used for TypeScript-based substring matching (case-insensitive), so:
- CRITICAL: Keywords must be PURE matching strings only!
  * NO parentheses or brackets with explanations
  * NO annotations or comments within keywords
  * Each keyword should be a clean, matchable string that could appear in actual data
- Minimum keyword length requirements to avoid false positives:
  * Chinese keywords: Try to avoid single character keyword, unless it is absolutely necessary.
  * English keywords: Try to avoid keyword less than 3 characters, unless it is absolutely necessary.
- Keywords from specific labels MUST NOT appear in fallback/catch-all labels

output in following json format:
\`\`\`json
{
"label_objective_clarification": "...",
"requirement": "Non-overlapping labels. Avoid redundancy for substring matching. All keywords combined must cover over 90% of the patterns in [input_data]!",
"keyword_config": {
    "{$non-overlapping label_name}": {"basic_keywords": ["{$keyword1}", ...], "extrapolate_keywords": ["{$keyword1}", ...]},
    ...
},
"unmatched_keyword_config": {
    "其他/未识别": ["{$keyword1}", "{$keyword2}", ...],
    ...
}
}
\`\`\``

const SUPPLEMENTARY_CONFIG_SYSTEM_PROMPT = `You are extending an EXISTING keyword configuration to improve coverage for unmatched samples.

[Existing keyword config]={existing_config}
[Existing labels]={existing_labels}
[Original label objective]='{cluster_objective}'
[Additional requirements]='{additional_requirements}'

[Tone and Wording style]=\`\`\`
*   **Professional, Direct, Easy to understand**
*   **PRIORITIZE extending existing labels over creating new ones**
*   **Maintain consistency with existing label semantics**
*   **Labels should be designed for QUANTITATIVE ANALYSIS**
*   **Keywords should be precise and minimal**
\`\`\`
[Language]=All labels and keywords should adapt the same language as [Original label objective].

Follow instructions step by step meticulously:
Step 1. Analyze [unmatched_samples] to understand WHY they were not matched by existing keywords.
Step 2. For EACH unmatched sample, determine:
   - Does it semantically belong to an existing label? → Extend that label's keywords (PREFERRED)
   - Is it genuinely a NEW distinct category? → Create a new label (MINIMIZE this)
Step 3. For extending existing labels:
   - Add keywords that capture variations, synonyms, or edge cases
   - Leverage your knowledge base to extrapolate related terms
   - Avoid redundancy for substring matching
Step 4. For new labels (only if absolutely necessary):
   - Ensure they are semantically distinct from existing labels

IMPORTANT: Keywords must be PURE matching strings only - NO annotations!

Output in following JSON format:
\`\`\`json
{
"analysis": "Brief analysis of why samples were unmatched and your extension strategy",
"label_extensions": {
    "{$existing_label_name}": {
        "basic_keywords": ["{$new_keyword1}", ...],
        "extrapolate_keywords": ["{$new_extrapolated_keyword1}", ...]
    },
    ...
},
"new_labels": {
    "{$new_label_name}": {
        "basic_keywords": ["{$keyword1}", ...],
        "extrapolate_keywords": ["{$keyword1}", ...]
    },
    ...
}
}
\`\`\``

const PREDEFINED_KEYWORDS_SYSTEM_PROMPT = `Your task is to generate comprehensive keywords for the PRE-DEFINED labels provided by user.

[label_objective]='{cluster_objective}'
[additional_requirements]='{additional_requirements}'
[pre_defined_labels]=\`\`\`
{predefined_labels}
\`\`\`

CRITICAL INSTRUCTIONS:
1. You MUST use the EXACT label names provided in [pre_defined_labels]. DO NOT modify, rename, or create new labels!
2. Your job is ONLY to generate keywords for each pre-defined label based on its definition.
3. Generate comprehensive keywords that would match data items belonging to each label.
4. Leverage your knowledge base to extrapolate related terms beyond what appears in sample data.

[Tone and Wording style]=\`\`\`
*   **Professional, Direct**
*   **Keywords should be precise and comprehensive**
*   **Avoid redundancy for substring matching**
\`\`\`
[Language]=All keywords should adapt the same language as [label_objective].

IMPORTANT: Keywords must be PURE matching strings only - NO annotations!

Output in following JSON format (use EXACT label names from [pre_defined_labels]):
\`\`\`json
{
"keyword_config": {
    "{$exact_predefined_label_name}": {
        "basic_keywords": ["{$keyword1}", ...],
        "extrapolate_keywords": ["{$extrapolated_keyword1}", ...]
    },
    ...
}
}
\`\`\``

// ==================== Main Class ====================

export class KeywordClusteringAgent {
  /**
   * Main processing method for keyword-based clustering and label assignment with iterative optimization.
   */
  async processKeywordClustering(
    clusterInput: Record<number, string>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    targetCoverage: number,
    iterativeRounds: number,
    preDefinedCategories: PreDefinedCategory[] | undefined,
    ctx: LLMContext,
  ): Promise<KeywordClusteringResult> {
    try {
      const iterationHistory: IterationStats[] = []
      let keywordConfig: KeywordConfig | null = null
      let labelAssignments: Record<string, string[]> = {}
      let coverageRate = 0
      let usedPreDefinedCategories = false

      log.info("Starting keyword clustering", {
        targetCoverage: `${targetCoverage * 100}%`,
        maxIterations: iterativeRounds,
      })

      // Check if pre_defined_categories is provided
      if (preDefinedCategories && preDefinedCategories.length > 0) {
        const hasUserKeywords = preDefinedCategories.some((cat) => cat.keywords && cat.keywords.length > 0)

        if (hasUserKeywords) {
          // User provided keywords, use them directly
          log.info("Using user-provided keywords", { count: preDefinedCategories.length })
          keywordConfig = {}
          for (const cat of preDefinedCategories) {
            const label = cat.label || ""
            const keywords = cat.keywords || []
            keywordConfig[label] = {
              basicKeywords: keywords,
              extrapolateKeywords: [],
            }
          }
          // Add "其他" category
          if (!keywordConfig["其他"]) {
            keywordConfig["其他"] = { basicKeywords: [], extrapolateKeywords: [] }
          }
          usedPreDefinedCategories = true
        } else {
          // User only provided labels and definitions, generate keywords
          log.info("Generating keywords for user-defined labels", { count: preDefinedCategories.length })
          keywordConfig = await this.generateKeywordsForPredefinedLabels(
            clusterInput,
            preDefinedCategories,
            clusterObjective,
            additionalRequirements,
            ctx,
          )
          usedPreDefinedCategories = true
        }
      }

      // Iterative optimization loop
      for (let iteration = 0; iteration < iterativeRounds; iteration++) {
        log.info(`===== Iteration ${iteration + 1}/${iterativeRounds} =====`)

        // Stage 1: Generate or supplement keyword configuration
        if (iteration === 0) {
          if (!keywordConfig) {
            log.info("Stage 1: Generating initial keyword mapping configuration")
            keywordConfig = await this.generateKeywordConfig(
              clusterInput,
              clusterObjective,
              additionalRequirements,
              ctx,
            )
          } else {
            log.info("Stage 1: Using pre-defined keyword configuration")
          }
        } else {
          log.info("Stage 1: Generating supplementary configuration for unmatched samples")

          // Extract unmatched samples from previous iteration
          const unmatchedSamples = this.extractUnmatchedSamples(clusterInput, labelAssignments)

          if (Object.keys(unmatchedSamples).length < CONFIG.minUnmatchedForIteration) {
            log.info(`Too few unmatched samples (${Object.keys(unmatchedSamples).length}), stopping iteration`)
            break
          }

          log.info(`Found ${Object.keys(unmatchedSamples).length} unmatched samples`)

          // Generate supplementary configuration
          const supplementaryConfig = await this.generateSupplementaryConfig(
            unmatchedSamples,
            keywordConfig!,
            clusterObjective,
            additionalRequirements,
            ctx,
          )

          // Merge configurations
          keywordConfig = this.mergeKeywordConfigs(keywordConfig!, supplementaryConfig)
          log.info(`Merged configurations, now have ${Object.keys(keywordConfig).length} labels`)
        }

        // Stage 2: Perform TypeScript-based keyword matching
        log.info("Stage 2: Performing keyword-based label assignment on full dataset")
        labelAssignments = this.performKeywordMatching(clusterInput, keywordConfig)

        // Stage 3: Calculate coverage rate
        coverageRate = this.calculateCoverage(labelAssignments)

        // Calculate statistics for this iteration
        const totalCount = Object.keys(labelAssignments).length
        const multiLabelCount = Object.values(labelAssignments).filter((labels) => labels.length > 1).length
        const otherCount = Object.values(labelAssignments).filter(
          (labels) => labels.length === 1 && labels[0] === "其他",
        ).length
        const uniqueLabels = Object.keys(keywordConfig).filter((l) => l !== "其他").length

        // Record iteration statistics
        const iterationStats: IterationStats = {
          iteration: iteration + 1,
          coverageRate: Math.round(coverageRate * 100) / 100,
          uniqueLabels,
          totalItems: totalCount,
          otherCount,
          multiLabelCount,
        }
        iterationHistory.push(iterationStats)

        log.info(`Iteration ${iteration + 1} results`, iterationStats)

        // Check if target coverage is achieved
        if (coverageRate >= targetCoverage * 100) {
          log.info(`Target coverage ${targetCoverage * 100}% achieved! Stopping iteration.`)
          break
        }

        // Check if this is the last iteration
        if (iteration === iterativeRounds - 1) {
          log.info(`Reached maximum iterations (${iterativeRounds})`)
          if (coverageRate < targetCoverage * 100) {
            log.warn(`Target coverage not achieved. Final coverage: ${coverageRate}%`)
          }
        }
      }

      log.info("Processing completed", {
        totalIterations: iterationHistory.length,
        finalCoverage: `${coverageRate}%`,
        targetAchieved: coverageRate >= targetCoverage * 100,
      })

      return {
        clusterObjectiveClarification: `基于'${clusterObjective}'进行关键词标签生成和分类`,
        keywordConfig: keywordConfig!,
        labelAssignments,
        coverageRate,
        iterationsPerformed: iterationHistory.length,
        iterationHistory,
        targetCoverage: targetCoverage * 100,
        targetAchieved: coverageRate >= targetCoverage * 100,
        usedPreDefinedCategories,
      }
    } catch (error) {
      log.error("Error in processKeywordClustering", { error })
      throw error
    }
  }

  /**
   * Stage 1: Generate keyword mapping configuration using LLM.
   */
  private async generateKeywordConfig(
    clusterInput: Record<number, string>,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    ctx: LLMContext,
  ): Promise<KeywordConfig> {
    // Sample data for keyword config generation
    const inputSize = Object.keys(clusterInput).length
    let sampleData: string

    if (inputSize <= CONFIG.minSampleThreshold) {
      sampleData = JSON.stringify(Object.values(clusterInput))
      log.info(`Using all items for keyword config generation (data size <= ${CONFIG.minSampleThreshold})`)
    } else {
      const sampleSize = Math.min(CONFIG.minSampleThreshold, Math.floor(inputSize * CONFIG.sampleRatio))
      const allIndices = Object.keys(clusterInput).map(Number)
      const sampleIndices = this.randomSample(allIndices, sampleSize)
      const sampled = sampleIndices.map((idx) => clusterInput[idx])
      sampleData = JSON.stringify(sampled)
      log.info(`Generating keyword config from ${sampleSize} sampled items`)
    }

    // Prepare prompt
    const systemPrompt = KEYWORD_CONFIG_SYSTEM_PROMPT.replace("{cluster_objective}", clusterObjective).replace(
      "{additional_requirements}",
      additionalRequirements || "",
    )

    const userMessage = `[input_data]=${sampleData}`

    // Call LLM
    const response = await this.callLLM(systemPrompt, userMessage, ctx)

    // Parse response
    const result = this.parseJSONResponse(response)
    const rawConfig = (result.keyword_config || {}) as Record<
      string,
      { basic_keywords?: string[]; extrapolate_keywords?: string[] }
    >

    // Convert to camelCase
    const keywordConfig: KeywordConfig = {}
    for (const [label, data] of Object.entries(rawConfig)) {
      keywordConfig[label] = {
        basicKeywords: Array.isArray(data.basic_keywords) ? data.basic_keywords : [],
        extrapolateKeywords: Array.isArray(data.extrapolate_keywords) ? data.extrapolate_keywords : [],
      }
    }

    log.info(`Keyword config generated with ${Object.keys(keywordConfig).length} labels`)
    return keywordConfig
  }

  /**
   * Generate keywords for pre-defined labels.
   */
  private async generateKeywordsForPredefinedLabels(
    clusterInput: Record<number, string>,
    preDefinedCategories: PreDefinedCategory[],
    clusterObjective: string,
    additionalRequirements: string | undefined,
    ctx: LLMContext,
  ): Promise<KeywordConfig> {
    // Sample data for reference
    const inputSize = Object.keys(clusterInput).length
    let sampleData: string

    if (inputSize <= CONFIG.minSampleThreshold) {
      sampleData = JSON.stringify(Object.values(clusterInput))
    } else {
      const sampleSize = Math.min(CONFIG.minSampleThreshold, Math.floor(inputSize * CONFIG.sampleRatio))
      const allIndices = Object.keys(clusterInput).map(Number)
      const sampleIndices = this.randomSample(allIndices, sampleSize)
      sampleData = JSON.stringify(sampleIndices.map((idx) => clusterInput[idx]))
    }

    // Build pre-defined labels info
    const predefinedLabelsInfo = preDefinedCategories.map((cat) => ({
      label: cat.label,
      definition: cat.definition && cat.definition !== "未提供" ? cat.definition : cat.label,
    }))

    // Prepare prompt
    const systemPrompt = PREDEFINED_KEYWORDS_SYSTEM_PROMPT.replace("{cluster_objective}", clusterObjective)
      .replace("{additional_requirements}", additionalRequirements || "")
      .replace("{predefined_labels}", JSON.stringify(predefinedLabelsInfo, null, 2))

    const userMessage = `[sample_data for reference]=${sampleData}`

    // Call LLM
    const response = await this.callLLM(systemPrompt, userMessage, ctx)

    // Parse response
    const result = this.parseJSONResponse(response)
    const rawConfig = (result.keyword_config || {}) as Record<
      string,
      { basic_keywords?: string[]; extrapolate_keywords?: string[] }
    >

    // Convert to camelCase and ensure all predefined labels are included
    const keywordConfig: KeywordConfig = {}
    const predefinedLabelNames = new Set(preDefinedCategories.map((cat) => cat.label))

    for (const [label, data] of Object.entries(rawConfig)) {
      keywordConfig[label] = {
        basicKeywords: Array.isArray(data.basic_keywords) ? data.basic_keywords : [],
        extrapolateKeywords: Array.isArray(data.extrapolate_keywords) ? data.extrapolate_keywords : [],
      }
    }

    // Ensure all predefined labels are included
    for (const labelName of predefinedLabelNames) {
      if (!(labelName in keywordConfig)) {
        log.warn(`Pre-defined label '${labelName}' not in generated config, adding with empty keywords`)
        keywordConfig[labelName] = { basicKeywords: [], extrapolateKeywords: [] }
      }
    }

    // Add "其他" category if not present
    if (!("其他" in keywordConfig)) {
      keywordConfig["其他"] = { basicKeywords: [], extrapolateKeywords: [] }
    }

    log.info(`Generated keywords for ${Object.keys(keywordConfig).length} pre-defined labels`)
    return keywordConfig
  }

  /**
   * Stage 2: Perform TypeScript-based keyword matching for multi-label assignment.
   */
  private performKeywordMatching(
    clusterInput: Record<number, string>,
    keywordConfig: KeywordConfig,
  ): Record<string, string[]> {
    const labelAssignments: Record<string, string[]> = {}

    for (const [idx, text] of Object.entries(clusterInput)) {
      const textLower = text.toLowerCase()
      const matchedLabels: string[] = []

      // Check each label's keywords
      for (const [labelName, keywordData] of Object.entries(keywordConfig)) {
        // Skip '其他' during matching (it's the fallback)
        if (labelName === "其他") continue

        // Extract keywords
        const basicKeywords = Array.isArray(keywordData.basicKeywords) ? keywordData.basicKeywords : []
        const extrapolateKeywords = Array.isArray(keywordData.extrapolateKeywords)
          ? keywordData.extrapolateKeywords
          : []
        const keywords = [...basicKeywords, ...extrapolateKeywords]

        // Check if any keyword matches (case-insensitive substring match)
        for (const keyword of keywords) {
          if (!keyword || !keyword.trim()) continue
          if (textLower.includes(keyword.toLowerCase())) {
            matchedLabels.push(labelName)
            break // Found a match for this label, move to next label
          }
        }
      }

      // Smart conflict resolution: remove fallback labels if specific labels exist
      if (matchedLabels.length > 0) {
        const specificLabels = matchedLabels.filter((l) => !this.isFallbackLabel(l))
        const fallbackLabels = matchedLabels.filter((l) => this.isFallbackLabel(l))

        if (specificLabels.length > 0) {
          labelAssignments[idx] = specificLabels
        } else if (fallbackLabels.length > 0) {
          labelAssignments[idx] = fallbackLabels
        } else {
          labelAssignments[idx] = matchedLabels
        }
      } else {
        // If no matches found, assign to '其他'
        labelAssignments[idx] = ["其他"]
      }
    }

    // Log statistics
    const multiLabelCount = Object.values(labelAssignments).filter((labels) => labels.length > 1).length
    const otherCount = Object.values(labelAssignments).filter(
      (labels) => labels.length === 1 && labels[0] === "其他",
    ).length
    log.info(`Keyword matching completed`, {
      totalItems: Object.keys(labelAssignments).length,
      multiLabelCount,
      otherCount,
    })

    return labelAssignments
  }

  /**
   * Check if a label is a fallback/catch-all label.
   */
  private isFallbackLabel(labelName: string): boolean {
    const patterns = ["其他", "未识别", "未分类", "未知", "other", "unknown", "unclassified"]
    const labelLower = labelName.toLowerCase()
    return patterns.some((pattern) => labelLower.includes(pattern))
  }

  /**
   * Calculate coverage rate (percentage of non-'其他' labels).
   */
  private calculateCoverage(labelAssignments: Record<string, string[]>): number {
    const totalCount = Object.keys(labelAssignments).length
    if (totalCount === 0) return 0

    const otherCount = Object.values(labelAssignments).filter(
      (labels) => labels.length === 1 && labels[0] === "其他",
    ).length
    const coverageRate = ((totalCount - otherCount) / totalCount) * 100

    return coverageRate
  }

  /**
   * Extract samples that were labeled as '其他'.
   */
  private extractUnmatchedSamples(
    clusterInput: Record<number, string>,
    labelAssignments: Record<string, string[]>,
  ): Record<number, string> {
    const unmatchedSamples: Record<number, string> = {}
    for (const [idxStr, labels] of Object.entries(labelAssignments)) {
      if (labels.length === 1 && labels[0] === "其他") {
        const idx = parseInt(idxStr, 10)
        if (idx in clusterInput) {
          unmatchedSamples[idx] = clusterInput[idx]
        }
      }
    }
    return unmatchedSamples
  }

  /**
   * Generate supplementary keyword configuration for unmatched samples.
   */
  private async generateSupplementaryConfig(
    unmatchedSamples: Record<number, string>,
    existingConfig: KeywordConfig,
    clusterObjective: string,
    additionalRequirements: string | undefined,
    ctx: LLMContext,
  ): Promise<SupplementaryConfig> {
    // Sample unmatched data
    const inputSize = Object.keys(unmatchedSamples).length
    let sampleData: string

    if (inputSize <= CONFIG.minSampleThreshold) {
      sampleData = JSON.stringify(Object.values(unmatchedSamples))
    } else {
      const sampleSize = Math.min(CONFIG.minSampleThreshold, Math.floor(inputSize * CONFIG.sampleRatio))
      const allIndices = Object.keys(unmatchedSamples).map(Number)
      const sampleIndices = this.randomSample(allIndices, sampleSize)
      sampleData = JSON.stringify(sampleIndices.map((idx) => unmatchedSamples[idx]))
    }

    // Prepare existing labels information
    const existingLabels = Object.keys(existingConfig)
      .filter((l) => l !== "其他")
      .map((l) => `'${l}'`)
      .join(", ")

    // Prepare prompt
    const systemPrompt = SUPPLEMENTARY_CONFIG_SYSTEM_PROMPT.replace(
      "{existing_config}",
      JSON.stringify(existingConfig, null, 2),
    )
      .replace("{existing_labels}", existingLabels)
      .replace("{cluster_objective}", clusterObjective)
      .replace("{additional_requirements}", additionalRequirements || "")

    const userMessage = `[unmatched_samples]=${sampleData}`

    // Call LLM
    const response = await this.callLLM(systemPrompt, userMessage, ctx)

    // Parse response
    const result = this.parseJSONResponse(response)

    // Convert to camelCase
    const labelExtensions: Record<string, KeywordData> = {}
    const rawExtensions = (result.label_extensions || {}) as Record<
      string,
      { basic_keywords?: string[]; extrapolate_keywords?: string[] }
    >
    for (const [label, data] of Object.entries(rawExtensions)) {
      labelExtensions[label] = {
        basicKeywords: Array.isArray(data.basic_keywords) ? data.basic_keywords : [],
        extrapolateKeywords: Array.isArray(data.extrapolate_keywords) ? data.extrapolate_keywords : [],
      }
    }

    const newLabels: Record<string, KeywordData> = {}
    const rawNewLabels = (result.new_labels || {}) as Record<
      string,
      { basic_keywords?: string[]; extrapolate_keywords?: string[] }
    >
    for (const [label, data] of Object.entries(rawNewLabels)) {
      newLabels[label] = {
        basicKeywords: Array.isArray(data.basic_keywords) ? data.basic_keywords : [],
        extrapolateKeywords: Array.isArray(data.extrapolate_keywords) ? data.extrapolate_keywords : [],
      }
    }

    log.info(`Supplementary config generated`, {
      extended: Object.keys(labelExtensions).length,
      newLabels: Object.keys(newLabels).length,
    })

    return {
      analysis: result.analysis as string | undefined,
      labelExtensions,
      newLabels,
    }
  }

  /**
   * Merge base keyword config with supplementary config.
   */
  private mergeKeywordConfigs(baseConfig: KeywordConfig, supplementaryConfig: SupplementaryConfig): KeywordConfig {
    const merged = structuredClone(baseConfig)

    // Process label extensions
    for (const [labelName, keywords] of Object.entries(supplementaryConfig.labelExtensions)) {
      if (merged[labelName]) {
        // Extend existing label
        merged[labelName].basicKeywords = [
          ...new Set([...merged[labelName].basicKeywords, ...keywords.basicKeywords]),
        ]
        merged[labelName].extrapolateKeywords = [
          ...new Set([...merged[labelName].extrapolateKeywords, ...keywords.extrapolateKeywords]),
        ]
      } else {
        log.warn(`Label '${labelName}' not found in base config, treating as new label`)
        merged[labelName] = keywords
      }
    }

    // Process new labels
    for (const [labelName, keywords] of Object.entries(supplementaryConfig.newLabels)) {
      if (!(labelName in merged)) {
        merged[labelName] = keywords
      } else {
        log.warn(`New label '${labelName}' already exists, merging keywords`)
        merged[labelName].basicKeywords = [
          ...new Set([...merged[labelName].basicKeywords, ...keywords.basicKeywords]),
        ]
        merged[labelName].extrapolateKeywords = [
          ...new Set([...merged[labelName].extrapolateKeywords, ...keywords.extrapolateKeywords]),
        ]
      }
    }

    return merged
  }

  // ==================== Helper Methods ====================

  private async callLLM(system: string, prompt: string, ctx: LLMContext): Promise<string> {
    const cfg = await Config.get()
    let model: Provider.Model

    // Use keyword_clustering_model from config, fallback to llm_tool_model, then small model
    if (cfg.keyword_clustering_model) {
      const parsed = Provider.parseModel(cfg.keyword_clustering_model)
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
