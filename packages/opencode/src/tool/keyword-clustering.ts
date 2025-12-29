/**
 * Keyword Clustering Tool
 *
 * LLM-powered keyword-based clustering and label assignment tool.
 * Performs fast classification using LLM-generated keywords with iterative optimization.
 *
 * Features:
 * - LLM generates comprehensive keyword configurations
 * - Fast TypeScript-based keyword matching (no LLM in classification)
 * - Iterative optimization to achieve target coverage
 * - Multi-label assignment support
 */

import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { DataFile } from "../util/datafile"
import { KeywordClusteringAgent, type PreDefinedCategory } from "../clustering/keyword-clustering-agent"
import { Log } from "../util/log"
import DESCRIPTION from "./keyword-clustering.txt"

const log = Log.create({ service: "tool.keyword-clustering" })

export const KeywordClusteringTool = Tool.define("keyword_clustering", {
  description: DESCRIPTION,

  parameters: z.object({
    clusterObjective: z.string().describe("The objective or goal for labeling (e.g., '对用户反馈进行标签分类')"),
    inputFile: z.string().describe("Input CSV or Excel file path"),
    clusterColumns: z.array(z.string()).describe("Column names to be used for labeling"),
    outputFile: z.string().describe("Output CSV or Excel file path"),
    outputLabelColumn: z.string().describe("Column name for the output labels"),
    additionalRequirements: z.string().optional().describe("Additional requirements for labeling"),
    targetCoverage: z.number().min(0).max(1).default(0.9).describe("Target coverage rate (0-1, default 0.9 = 90%)"),
    iterativeRounds: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(3)
      .describe("Maximum number of iterations (default 3)"),
    preDefinedCategories: z
      .array(
        z.object({
          label: z.string().describe("Category label name"),
          definition: z.string().optional().describe(
            "Category definition. Used by LLM to generate keywords when keywords not provided."
          ),
          keywords: z.array(z.string()).optional().describe(
            "Keywords for substring matching (case-insensitive). " +
            "When provided: LLM keyword generation SKIPPED, your keywords used directly. " +
            "Keywords should be clean strings without annotations or explanations."
          ),
        }),
      )
      .optional()
      .describe(
        "Pre-defined categories for keyword-based labeling. " +
        "Provide keywords to use directly, or provide definitions for LLM to generate keywords."
      ),
  }),

  async execute(params, ctx) {
    const startTime = Date.now()
    log.info("Starting keyword clustering", {
      inputFile: params.inputFile,
      outputFile: params.outputFile,
      clusterColumns: params.clusterColumns,
      targetCoverage: `${params.targetCoverage * 100}%`,
      iterativeRounds: params.iterativeRounds,
    })

    try {
      // Read input data
      const inputPath = path.isAbsolute(params.inputFile)
        ? params.inputFile
        : path.join(process.cwd(), params.inputFile)

      const data = await DataFile.read(inputPath)
      log.info("Read input file", { rows: data.length })

      if (data.length === 0) {
        throw new Error("Input file is empty")
      }

      // Prepare cluster input: combine specified columns into text
      const clusterInput: Record<number, string> = {}
      const uniqueTexts = new Map<string, number[]>() // text -> row indices

      for (let i = 0; i < data.length; i++) {
        const row = data[i]
        let text = ""
        for (const col of params.clusterColumns) {
          if (col === "user_id") continue
          const value = row[col] ?? ""
          text += value
        }

        if (!uniqueTexts.has(text)) {
          uniqueTexts.set(text, [])
        }
        uniqueTexts.get(text)!.push(i)
      }

      // Create cluster input with unique texts
      let uniqueIndex = 0
      const textToUniqueIndex = new Map<string, number>()
      for (const text of uniqueTexts.keys()) {
        clusterInput[uniqueIndex] = text
        textToUniqueIndex.set(text, uniqueIndex)
        uniqueIndex++
      }

      log.info("Prepared cluster input", {
        totalRows: data.length,
        uniqueItems: Object.keys(clusterInput).length,
      })

      // Run keyword clustering
      const agent = new KeywordClusteringAgent()
      const result = await agent.processKeywordClustering(
        clusterInput,
        params.clusterObjective,
        params.additionalRequirements,
        params.targetCoverage,
        params.iterativeRounds,
        params.preDefinedCategories as PreDefinedCategory[] | undefined,
        { abort: ctx.abort },
      )

      // Map label assignments back to original data
      for (let i = 0; i < data.length; i++) {
        const row = data[i]
        let text = ""
        for (const col of params.clusterColumns) {
          if (col === "user_id") continue
          const value = row[col] ?? ""
          text += value
        }

        const uniqueIdx = textToUniqueIndex.get(text)
        if (uniqueIdx !== undefined) {
          const assignedLabels = result.labelAssignments[String(uniqueIdx)]
          if (assignedLabels && assignedLabels.length > 0) {
            row[params.outputLabelColumn] = assignedLabels.join("; ")
          } else {
            row[params.outputLabelColumn] = text.trim() === "" ? "受访者未回答" : "其他"
          }
        } else {
          row[params.outputLabelColumn] = text.trim() === "" ? "受访者未回答" : "其他"
        }
      }

      // Limit output columns
      const limitedData = DataFile.limitOutputColumns(data, params.outputLabelColumn, params.clusterColumns)

      // Check for multi-label items and explode if needed
      let outputData = limitedData
      let hasMultipleClassifications = false

      for (const row of outputData) {
        const value = row[params.outputLabelColumn]
        if (value && value.includes("; ") && value !== "其他") {
          hasMultipleClassifications = true
          break
        }
      }

      if (hasMultipleClassifications) {
        // Explode multi-label rows
        const explodedData: Record<string, string>[] = []
        for (const row of outputData) {
          const labelValue = row[params.outputLabelColumn]
          if (labelValue && labelValue.includes("; ") && labelValue !== "其他") {
            const labels = labelValue.split("; ")
            for (const label of labels) {
              explodedData.push({ ...row, [params.outputLabelColumn]: label })
            }
          } else {
            explodedData.push(row)
          }
        }
        outputData = explodedData
        log.info("Exploded multi-label rows", { originalRows: limitedData.length, newRows: outputData.length })
      }

      // Compute output file paths with proper naming convention
      const ext = path.extname(params.outputFile)
      const baseName = params.outputFile.slice(0, -ext.length)

      // Main output file with suffix
      const mainOutputFileName = `${baseName}_关键词标签明细表${ext}`
      const outputPath = path.isAbsolute(mainOutputFileName)
        ? mainOutputFileName
        : path.join(process.cwd(), mainOutputFileName)

      await DataFile.write(outputPath, outputData)
      log.info("Wrote output file", { path: outputPath, rows: outputData.length })

      // Write main metadata as Python class file
      const metadataPyPath = DataFile.getMetadataPyPath(outputPath)
      const metadataPy = DataFile.generateClusteringMetadataPy({
        file_name: path.basename(outputPath),
        file_path: outputPath,
        description: `针对${params.inputFile}的${params.clusterColumns.join(", ")}字段进行关键词标签生成，生成结果在'${params.outputLabelColumn}'字段`,
        originated_from: params.inputFile,
        generate_process: [
          {
            stepName: "关键词生成",
            detailProcessDescription: `根据标签目标'${params.clusterObjective}'，使用大语言模型生成${Object.keys(result.keywordConfig).length}个标签及其关键词${params.additionalRequirements ? `，额外要求：${params.additionalRequirements}` : ""}`,
            type: "Transform",
            inputColumns: params.clusterColumns,
            resultShape: `(${outputData.length}, ${Object.keys(outputData[0] || {}).length})`,
          },
          {
            stepName: "关键词匹配",
            detailProcessDescription: `使用关键词匹配进行标签分类，经过${result.iterationsPerformed}轮迭代优化`,
            type: "Map",
            inputColumns: params.clusterColumns,
            resultShape: `(${outputData.length}, ${Object.keys(outputData[0] || {}).length})`,
          },
        ],
        table_taxonomy: "Fact-Dimension Table",
        columns_desc: {
          [params.outputLabelColumn]: "关键词分类标签",
          user_id: "用户唯一标识",
          ...Object.fromEntries(params.clusterColumns.map(c => [c, "标签输入字段"])),
        },
        extra_fields: {
          keywordConfig: result.keywordConfig,
          outputColumns: [params.outputLabelColumn],
          coverageRate: result.coverageRate,
          iterationsPerformed: result.iterationsPerformed,
          iterationHistory: result.iterationHistory,
          targetAchieved: result.targetAchieved,
          usedPreDefinedCategories: result.usedPreDefinedCategories,
        },
      })
      await Bun.write(metadataPyPath, metadataPy)

      // Write keyword config file
      const configFilePath = `${baseName}_关键词配置表.csv`
      const configPath = path.isAbsolute(configFilePath) ? configFilePath : path.join(process.cwd(), configFilePath)

      const configData: Record<string, string>[] = []
      for (const [labelName, keywordData] of Object.entries(result.keywordConfig)) {
        const allKeywords = [...keywordData.basicKeywords, ...keywordData.extrapolateKeywords]
        configData.push({
          label_name: labelName,
          keywords: allKeywords.join("; "),
          keyword_count: String(allKeywords.length),
        })
      }
      await DataFile.write(configPath, configData)

      // Write config file metadata as Python class file
      const configMetadataPyPath = DataFile.getMetadataPyPath(configPath)
      const configMetadataPy = DataFile.generateClusteringMetadataPy({
        file_name: path.basename(configPath),
        file_path: configPath,
        description: `${params.clusterObjective}的关键词配置表`,
        originated_from: params.inputFile,
        generate_process: [
          {
            stepName: "关键词配置提取",
            detailProcessDescription: `从关键词聚类过程中提取的标签配置，包含每个标签的名称、关键词列表和关键词数量`,
            type: "Extract",
            inputColumns: params.clusterColumns,
            resultShape: `(${configData.length}, 3)`,
          },
        ],
        table_taxonomy: "Config Table",
        columns_desc: {
          label_name: "标签名称",
          keywords: "匹配关键词列表（分号分隔）",
          keyword_count: "关键词数量",
        },
      })
      await Bun.write(configMetadataPyPath, configMetadataPy)

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.info("Keyword clustering completed", { executionTime: `${executionTime}s` })

      const labelCount = Object.keys(result.keywordConfig).filter((l) => l !== "其他").length
      const iterationInfo =
        result.iterationHistory.length > 1
          ? `\n- Iterations: ${result.iterationHistory.map((h) => `Round ${h.iteration}: ${h.coverageRate}% coverage`).join(", ")}`
          : ""

      const outputMessage = `Keyword clustering completed successfully.
- Created ${labelCount} labels: ${Object.keys(result.keywordConfig).filter((l) => l !== "其他").join(", ")}
- Final coverage: ${result.coverageRate.toFixed(1)}% ${result.targetAchieved ? "(target achieved)" : "(target not reached)"}
- Output: ${mainOutputFileName} (${outputData.length} rows)
- Keyword config: ${configFilePath}
- Execution time: ${executionTime}s${iterationInfo}${hasMultipleClassifications ? "\n- Multi-label items were exploded to separate rows" : ""}`

      return {
        title: "Keyword Clustering",
        metadata: {
          inputFile: params.inputFile,
          outputFile: mainOutputFileName,
          labelCount,
          rowCount: outputData.length,
          coverageRate: `${result.coverageRate.toFixed(1)}%`,
          targetAchieved: result.targetAchieved,
          iterations: result.iterationsPerformed,
          executionTime: `${executionTime}s`,
        },
        output: outputMessage,
      }
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.error("Keyword clustering failed", { error, executionTime: `${executionTime}s` })
      throw error
    }
  },
})
