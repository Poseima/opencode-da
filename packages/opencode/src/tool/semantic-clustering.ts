/**
 * Semantic Clustering Tool
 *
 * LLM-powered semantic clustering and classification tool for data analysis.
 * Performs two-stage processing:
 * 1. Sample-based clustering to generate cluster definitions
 * 2. Full dataset classification using the generated clusters
 */

import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { DataFile } from "../util/datafile"
import { SemanticClusteringAgent, type PreDefinedCategory } from "../clustering/semantic-clustering-agent"
import { Log } from "../util/log"
import DESCRIPTION from "./semantic-clustering.txt"

const log = Log.create({ service: "tool.semantic-clustering" })

export const SemanticClusteringTool = Tool.define("semantic_clustering", {
  description: DESCRIPTION,

  parameters: z.object({
    clusterObjective: z.string().describe("The objective or goal for clustering (e.g., '对用户反馈进行分类')"),
    inputFile: z.string().describe("Input CSV or Excel file path"),
    clusterColumns: z.array(z.string()).describe("Column names to be used for clustering"),
    outputFile: z.string().describe("Output CSV or Excel file path"),
    outputLabelColumn: z.string().describe("Column name for the output cluster labels"),
    additionalRequirements: z.string().optional().describe("Additional requirements for clustering"),
    preDefinedCategories: z
      .array(
        z.object({
          label: z.string().describe("Category label name"),
          definition: z.string().optional().describe(
            "Category definition explaining what belongs in this category. " +
            "When ALL categories have definitions: LLM Stage 1 is SKIPPED, definitions used as-is. " +
            "When definitions missing: LLM generates definitions from sample data."
          ),
        }),
      )
      .optional()
      .describe(
        "Pre-defined categories for semantic classification. " +
        "Provide complete definitions to skip LLM clustering and use your categories directly."
      ),
  }),

  async execute(params, ctx) {
    const startTime = Date.now()
    log.info("Starting semantic clustering", {
      inputFile: params.inputFile,
      outputFile: params.outputFile,
      clusterColumns: params.clusterColumns,
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

      // Run semantic clustering
      const agent = new SemanticClusteringAgent()
      const result = await agent.processClustering(
        clusterInput,
        params.clusterObjective,
        params.additionalRequirements,
        params.preDefinedCategories as PreDefinedCategory[] | undefined,
        { abort: ctx.abort },
      )

      // Create reverse mapping from tagline index to tagline name
      const allTaglines = { ...result.clusterTaglines, ...result.step2ClusterTaglines }
      const indexToTagline: Record<number, string> = {}
      for (const [tagline, idx] of Object.entries(allTaglines)) {
        indexToTagline[idx] = tagline
      }

      // Map classifications back to original data
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
          const assignedTaglines = result.taglineClassification[String(uniqueIdx)]
          if (assignedTaglines && assignedTaglines.length > 0) {
            // Convert tagline indices to names
            const taglineNames: string[] = []
            for (const taglineIdx of assignedTaglines) {
              const idx = parseInt(String(taglineIdx), 10)
              if (indexToTagline[idx]) {
                taglineNames.push(indexToTagline[idx])
              }
            }
            row[params.outputLabelColumn] = taglineNames.length > 0 ? taglineNames.join("; ") : "其他"
          } else {
            row[params.outputLabelColumn] = text.trim() === "" ? "受访者未回答" : "其他"
          }
        } else {
          row[params.outputLabelColumn] = text.trim() === "" ? "受访者未回答" : "其他"
        }
      }

      // Limit output columns
      const limitedData = DataFile.limitOutputColumns(
        data,
        params.outputLabelColumn,
        params.clusterColumns,
      )

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
      const mainOutputFileName = `${baseName}_语义工具标签明细表${ext}`
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
        description: `针对${params.inputFile}的${params.clusterColumns.join(", ")}字段进行语义聚类，生成结果在'${params.outputLabelColumn}'字段`,
        originated_from: params.inputFile,
        generate_process: [
          {
            stepName: "语义聚类",
            detailProcessDescription: `使用大语言模型对文本进行语义理解，根据聚类目标'${params.clusterObjective}'生成聚类标签${params.additionalRequirements ? `，额外要求：${params.additionalRequirements}` : ""}`,
            type: "Transform",
            inputColumns: params.clusterColumns,
            resultShape: `(${outputData.length}, ${Object.keys(outputData[0] || {}).length})`,
          },
        ],
        table_taxonomy: "Fact-Dimension Table",
        columns_desc: {
          [params.outputLabelColumn]: "聚类分类标签",
          user_id: "用户唯一标识",
          ...Object.fromEntries(params.clusterColumns.map(c => [c, "聚类输入字段"])),
        },
        extra_fields: {
          clusterDefinitions: result.clusterDefinitions,
          clusterTaglines: result.clusterTaglines,
          outputColumns: [params.outputLabelColumn],
          usedPreDefinedCategories: result.usedPreDefinedCategories,
        },
      })
      await Bun.write(metadataPyPath, metadataPy)

      // Write cluster definitions file
      const defFilePath = `${baseName}_语义工具标签定义.csv`
      const defPath = path.isAbsolute(defFilePath)
        ? defFilePath
        : path.join(process.cwd(), defFilePath)

      const defData: Record<string, string>[] = []
      for (const [tagline, definition] of Object.entries(result.clusterDefinitions)) {
        defData.push({
          cluster_tagline: tagline,
          cluster_definition: definition,
        })
      }
      await DataFile.write(defPath, defData)

      // Write definition file metadata as Python class file
      const defMetadataPyPath = DataFile.getMetadataPyPath(defPath)
      const defMetadataPy = DataFile.generateClusteringMetadataPy({
        file_name: path.basename(defPath),
        file_path: defPath,
        description: `${params.clusterObjective}的聚类标签定义表`,
        originated_from: params.inputFile,
        generate_process: [
          {
            stepName: "标签定义生成",
            detailProcessDescription: `从语义聚类过程中提取的标签定义，包含每个标签的名称和详细定义说明`,
            type: "Extract",
            inputColumns: params.clusterColumns,
            resultShape: `(${defData.length}, 2)`,
          },
        ],
        table_taxonomy: "Config Table",
        columns_desc: {
          cluster_tagline: "聚类标签名称",
          cluster_definition: "聚类标签定义说明",
        },
      })
      await Bun.write(defMetadataPyPath, defMetadataPy)

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.info("Semantic clustering completed", { executionTime: `${executionTime}s` })

      const clusterCount = Object.keys(result.clusterTaglines).length
      const outputMessage = `Semantic clustering completed successfully.
- Created ${clusterCount} clusters: ${Object.keys(result.clusterTaglines).join(", ")}
- Output: ${mainOutputFileName} (${outputData.length} rows)
- Cluster definitions: ${defFilePath}
- Execution time: ${executionTime}s${hasMultipleClassifications ? "\n- Multi-label items were exploded to separate rows" : ""}`

      return {
        title: "Semantic Clustering",
        metadata: {
          inputFile: params.inputFile,
          outputFile: mainOutputFileName,
          clusterCount,
          rowCount: outputData.length,
          executionTime: `${executionTime}s`,
        },
        output: outputMessage,
      }
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.error("Semantic clustering failed", { error, executionTime: `${executionTime}s` })
      throw error
    }
  },
})
