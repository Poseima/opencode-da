/**
 * Initialize Data File Metadata Tool
 *
 * Generates comprehensive metadata for data files using LLM semantic analysis
 * and statistical assessments (cohesiveness, data types) from data_describer.py.
 */

import z from "zod"
import path from "path"
import * as XLSX from "xlsx"
import { generateText } from "ai"
import { Tool } from "./tool"
import { DataFile } from "../util/datafile"
import { Provider } from "../provider/provider"
import { Config } from "../config/config"
import { Log } from "../util/log"
import DESCRIPTION from "./init-data-metadata.txt"

const log = Log.create({ service: "tool.init-data-metadata" })

// ==================== Configuration ====================

const CONFIG = {
  fieldBatchSize: 12, // Fields per batch for LLM description generation
  sampleRows: 10, // Number of rows to sample for LLM preview
  maxSampleValueLength: 50, // Max length for sample values in prompt
  maxConcurrency: 1, // Max concurrent LLM calls (set to 1 for rate-limited APIs)
}

/**
 * Execute promises with concurrency limit
 */
async function withConcurrencyLimit<T>(
  tasks: (() => Promise<T>)[],
  limit: number,
): Promise<T[]> {
  if (limit <= 0 || limit >= tasks.length) {
    // No limit or limit exceeds task count - run all in parallel
    return Promise.all(tasks.map((task) => task()))
  }

  const results: T[] = []
  const executing: Promise<void>[] = []

  for (const task of tasks) {
    const p = task().then((result) => {
      results.push(result)
    })
    executing.push(p as unknown as Promise<void>)

    if (executing.length >= limit) {
      await Promise.race(executing)
      // Remove completed promises
      for (let i = executing.length - 1; i >= 0; i--) {
        const status = await Promise.race([executing[i], Promise.resolve("pending")])
        if (status !== "pending") {
          executing.splice(i, 1)
        }
      }
    }
  }

  await Promise.all(executing)
  return results
}

// ==================== Types ====================

interface ColumnDesc {
  description: string
  dataType: string
  cohesiveness: string
  uniqueCount: number
  nullRatio: number
  clusteringHint?: boolean
}

interface SheetMetadata {
  sheet_name: string
  description: string
  shape: [number, number]
  columns_desc: Record<string, ColumnDesc>
}

interface DataFileMetadata {
  file_name: string
  file_path: string
  last_modified_time: string
  description: string
  originated_from: string[]
  table_taxonomy: string
  sheets: SheetMetadata[]
}

interface TableOverview {
  description: string
  field_relationships: string
  sheet_relationships: string
  table_taxonomy: string
}

interface LLMContext {
  abort: AbortSignal
}

// ==================== LLM Prompts ====================

const TABLE_OVERVIEW_SYSTEM_PROMPT = `You are a data analysis assistant. Analyze tabular data and generate metadata.

Output JSON with:
1. "description": Detailed description of what this data contains and its purpose
2. "field_relationships": Describe how fields/columns relate (PK/FK, derived fields, grouping relationships)
3. "sheet_relationships": If multiple sheets, describe their relationships. If single sheet, write "单表数据"
4. "table_taxonomy": Choose one from: "Fact-Dimension Table", "Stat Table", "Config Table", "Quote Table"

Requirements:
- Response MUST be valid JSON only, no markdown code blocks
- Use Chinese for all descriptions
- Be specific about the data content and business meaning
- Consider column names and sample values when inferring purpose`

const TABLE_OVERVIEW_USER_PROMPT = `Analyze the following table data and generate overview metadata:

File: {file_name}
Number of sheets: {sheet_count}
Sheet names: {sheet_names}

Data Preview (sample rows from each sheet):
---
{preview}
---

Generate a JSON object with "description", "field_relationships", "sheet_relationships", and "table_taxonomy" fields:`

const FIELD_DESCRIPTION_SYSTEM_PROMPT = `You are a data dictionary assistant. Generate brief descriptions for each field.

Output a valid JSON object with the following structure:
{
  "field_descriptions": {
    "column_name_1": "Brief description of what this field represents",
    "column_name_2": "Brief description of what this field represents"
  }
}

Requirements:
- Response MUST be valid JSON only, no markdown code blocks
- Use Chinese for all descriptions
- Keep each description to 1-2 sentences maximum
- Infer meaning from column name, data type, and sample values
- For numeric fields, mention what the values might represent
- For categorical fields, describe the categories if apparent`

const FIELD_DESCRIPTION_USER_PROMPT = `Generate descriptions for the following {field_count} data fields:

Field Information:
---
{field_info}
---

Generate a JSON object with "field_descriptions" mapping each column name to its description:`

// ==================== Statistical Analysis Functions ====================

/**
 * Detect if values contain list-type data (including string-formatted lists)
 */
function detectListType(values: unknown[]): boolean {
  return values.some((v) => {
    if (Array.isArray(v)) return true
    if (typeof v === "string") {
      const trimmed = v.trim()
      return (
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        (trimmed.startsWith("(") && trimmed.endsWith(")"))
      )
    }
    return false
  })
}

/**
 * Parse string-formatted list into actual array
 */
function safeParseListString(val: unknown): unknown {
  if (val == null) return val
  if (Array.isArray(val)) return val

  if (typeof val === "string") {
    const trimmed = val.trim()
    if (
      (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
      (trimmed.startsWith("(") && trimmed.endsWith(")"))
    ) {
      try {
        // Use JSON.parse for simple array-like strings
        const parsed = JSON.parse(trimmed.replace(/'/g, '"'))
        if (Array.isArray(parsed)) return parsed
      } catch {
        // Failed to parse, return original
      }
    }
  }
  return val
}

/**
 * Get data type classification for a column
 */
function getDataTypeClassification(values: unknown[]): string {
  const sample = values.filter((v) => v != null && v !== "").slice(0, 10)
  if (sample.length === 0) return "object"

  // Check for list type (including string-formatted lists)
  if (detectListType(sample)) return "list"

  // Check boolean
  if (sample.every((v) => typeof v === "boolean" || v === "true" || v === "false")) {
    return "bool"
  }

  // Check numeric types
  const numericSample = sample.map((v) => Number(v))
  if (numericSample.every((n) => !isNaN(n))) {
    if (numericSample.every((n) => Number.isInteger(n))) {
      return "int"
    }
    return "float"
  }

  // Check datetime
  const stringSample = sample.filter((v) => typeof v === "string") as string[]
  if (
    stringSample.length > 0 &&
    stringSample.every((v) => {
      const d = Date.parse(v)
      return !isNaN(d) && v.match(/\d{4}[-/]\d{1,2}[-/]\d{1,2}/)
    })
  ) {
    return "datetime"
  }

  return "string"
}

/**
 * Calculate cohesiveness label for a column
 * High Cohesiveness: uniqueCount < 30 AND top3 penetration > 20%
 */
function getCohesivenessLabel(values: unknown[], isListType: boolean): string {
  // For list types, explode first
  let workingValues: unknown[]

  if (isListType) {
    workingValues = values
      .flatMap((v) => {
        const parsed = safeParseListString(v)
        return Array.isArray(parsed) ? parsed : [v]
      })
      .filter((v) => v != null && v !== "")
  } else {
    workingValues = values.filter((v) => v != null && v !== "")
  }

  if (workingValues.length === 0) return "Low Cohesiveness"

  // Condition 1: Unique values < 30
  const uniqueSet = new Set(workingValues.map((v) => String(v)))
  const uniqueCount = uniqueSet.size

  if (uniqueCount >= 30) return "Low Cohesiveness"

  // Condition 2: Top 3 penetration > 20%
  const valueCounts = new Map<string, number>()
  for (const v of workingValues) {
    const key = String(v)
    valueCounts.set(key, (valueCounts.get(key) || 0) + 1)
  }

  const sortedCounts = [...valueCounts.values()].sort((a, b) => b - a)
  const top3Sum = sortedCounts.slice(0, 3).reduce((a, b) => a + b, 0)
  const penetration = top3Sum / workingValues.length

  return penetration > 0.2 ? "High Cohesiveness" : "Low Cohesiveness"
}

// ==================== File Reading Functions ====================

/**
 * Read all sheets from an Excel or CSV file
 */
async function readAllSheets(
  filePath: string,
): Promise<Record<string, Record<string, string>[]>> {
  const ext = path.extname(filePath).toLowerCase()
  const file = Bun.file(filePath)

  if (!(await file.exists())) {
    throw new Error(`File not found: ${filePath}`)
  }

  if (ext === ".csv") {
    // CSV has only one sheet
    const data = await DataFile.read(filePath)
    return { Sheet1: data }
  } else if (ext === ".xlsx" || ext === ".xls") {
    // Excel may have multiple sheets
    const buffer = await file.arrayBuffer()
    const workbook = XLSX.read(buffer, { type: "array" })
    const result: Record<string, Record<string, string>[]> = {}

    for (const sheetName of workbook.SheetNames) {
      const worksheet = workbook.Sheets[sheetName]
      const jsonData = XLSX.utils.sheet_to_json(worksheet, {
        header: 1,
        raw: false,
        defval: "",
      }) as unknown as unknown[][]

      if (jsonData.length === 0) {
        result[sheetName] = []
        continue
      }

      const headers = (jsonData[0] as unknown[]).map((h) => String(h ?? ""))
      const records: Record<string, string>[] = []

      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i] as unknown[]
        const record: Record<string, string> = {}

        for (let j = 0; j < headers.length; j++) {
          record[headers[j]] = String(row[j] ?? "")
        }

        records.push(record)
      }

      result[sheetName] = records
    }

    return result
  } else {
    throw new Error(`Unsupported file format: ${ext}. Supported formats: .csv, .xlsx, .xls`)
  }
}

// ==================== LLM Functions ====================

async function callLLM(system: string, prompt: string, ctx: LLMContext): Promise<string> {
  const cfg = await Config.get()
  let model: Provider.Model

  // Use llm_tool_model from config, fallback to small model
  if (cfg.llm_tool_model) {
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

function parseJSONResponse(response: string): Record<string, unknown> {
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

/**
 * Generate table overview using LLM (with all sheets info)
 */
async function generateTableOverview(
  fileName: string,
  allSheetsData: Record<string, Record<string, string>[]>,
  ctx: LLMContext,
): Promise<TableOverview> {
  const sheetNames = Object.keys(allSheetsData)
  const sheetCount = sheetNames.length

  // Build preview for ALL sheets
  let preview = ""
  for (const sheetName of sheetNames) {
    const data = allSheetsData[sheetName]
    if (data.length === 0) continue

    const columns = Object.keys(data[0] || {})
    const sampleRows = data.slice(0, CONFIG.sampleRows)

    preview += `### Sheet: ${sheetName}\n`
    preview += `Shape: ${data.length} rows x ${columns.length} columns\n`
    preview += `Columns: ${columns.join(", ")}\n`
    preview += `Sample data (first ${sampleRows.length} rows):\n`

    for (const row of sampleRows) {
      const rowValues = columns.map((col) => {
        const val = row[col] || ""
        return val.length > CONFIG.maxSampleValueLength
          ? val.slice(0, CONFIG.maxSampleValueLength) + "..."
          : val
      })
      preview += rowValues.join(" | ") + "\n"
    }
    preview += "\n"
  }

  const userPrompt = TABLE_OVERVIEW_USER_PROMPT.replace("{file_name}", fileName)
    .replace("{sheet_count}", String(sheetCount))
    .replace("{sheet_names}", sheetNames.join(", "))
    .replace("{preview}", preview)

  const defaultResult: TableOverview = {
    description: `数据文件: ${fileName}`,
    field_relationships: "",
    sheet_relationships: sheetCount === 1 ? "单表数据" : `包含${sheetCount}个sheet: ${sheetNames.join(", ")}`,
    table_taxonomy: "Fact-Dimension Table",
  }

  try {
    const response = await callLLM(TABLE_OVERVIEW_SYSTEM_PROMPT, userPrompt, ctx)
    const result = parseJSONResponse(response)

    return {
      description: (result.description as string) || defaultResult.description,
      field_relationships: (result.field_relationships as string) || "",
      sheet_relationships: (result.sheet_relationships as string) || defaultResult.sheet_relationships,
      table_taxonomy: (result.table_taxonomy as string) || "Fact-Dimension Table",
    }
  } catch (error) {
    log.warn("Failed to generate table overview, using defaults", { error })
    return defaultResult
  }
}

/**
 * Generate field descriptions for a single batch using LLM
 */
async function generateFieldBatch(
  data: Record<string, string>[],
  batch: string[],
  stats: Record<string, ColumnDesc>,
  ctx: LLMContext,
): Promise<Record<string, string>> {
  // Build field info for prompt
  const fieldInfo = batch
    .map((col) => {
      const stat = stats[col]
      const samples = data
        .slice(0, 5)
        .map((row) => row[col])
        .filter((v) => v != null && v !== "")
        .map((v) =>
          String(v).length > CONFIG.maxSampleValueLength
            ? String(v).slice(0, CONFIG.maxSampleValueLength) + "..."
            : v,
        )

      const nonNullCount = data.length - Math.round(stat.nullRatio * data.length)

      return (
        `- ${col}: dtype=${stat.dataType}, ` +
        `non_null=${nonNullCount}, null_ratio=${(stat.nullRatio * 100).toFixed(1)}%, ` +
        `unique=${stat.uniqueCount}, ` +
        `samples=${JSON.stringify(samples)}`
      )
    })
    .join("\n")

  const userPrompt = FIELD_DESCRIPTION_USER_PROMPT.replace(
    "{field_count}",
    String(batch.length),
  ).replace("{field_info}", fieldInfo)

  try {
    const response = await callLLM(FIELD_DESCRIPTION_SYSTEM_PROMPT, userPrompt, ctx)
    const parsed = parseJSONResponse(response)
    const descriptions = (parsed.field_descriptions as Record<string, string>) || {}

    const result: Record<string, string> = {}
    for (const col of batch) {
      result[col] = descriptions[col] || col
    }
    return result
  } catch (error) {
    log.warn(`Failed to generate descriptions for batch, using column names`, { error })
    // Fallback: use column name as description
    const result: Record<string, string> = {}
    for (const col of batch) {
      result[col] = col
    }
    return result
  }
}

/**
 * Generate field descriptions in batches using LLM (parallel execution)
 */
async function generateFieldDescriptionsInBatches(
  data: Record<string, string>[],
  columns: string[],
  stats: Record<string, ColumnDesc>,
  ctx: LLMContext,
): Promise<Record<string, string>> {
  // Build all batches upfront
  const batches: string[][] = []
  for (let i = 0; i < columns.length; i += CONFIG.fieldBatchSize) {
    batches.push(columns.slice(i, i + CONFIG.fieldBatchSize))
  }

  // Execute all batches in parallel
  const batchPromises = batches.map((batch) => generateFieldBatch(data, batch, stats, ctx))
  const batchResults = await Promise.all(batchPromises)

  // Merge all results
  const result: Record<string, string> = {}
  for (const batchResult of batchResults) {
    Object.assign(result, batchResult)
  }
  return result
}

// ==================== Utility Functions ====================

/**
 * Calculate statistics for all columns in a sheet (pure computation, no LLM)
 */
function calculateSheetStats(data: Record<string, string>[]): Record<string, ColumnDesc> {
  if (data.length === 0) return {}

  const columns = Object.keys(data[0])
  const columnsDesc: Record<string, ColumnDesc> = {}

  for (const col of columns) {
    const values = data.map((row) => row[col])
    const nonEmptyValues = values.filter((v) => v != null && v !== "")
    const isListType = detectListType(nonEmptyValues.slice(0, 10))

    columnsDesc[col] = {
      description: col, // Placeholder, will be updated by LLM
      dataType: getDataTypeClassification(values),
      cohesiveness: getCohesivenessLabel(values, isListType),
      uniqueCount: new Set(nonEmptyValues).size,
      nullRatio: (values.length - nonEmptyValues.length) / (values.length || 1),
    }

    // Add clustering hint
    if (
      columnsDesc[col].cohesiveness === "Low Cohesiveness" &&
      columnsDesc[col].uniqueCount > 200
    ) {
      columnsDesc[col].clusteringHint = true
    }
  }

  return columnsDesc
}

/**
 * Format date in CST timezone (UTC+8)
 */
function formatCST(date: Date): string {
  const cst = new Date(date.getTime() + 8 * 60 * 60 * 1000)
  return cst.toISOString().slice(0, 19).replace("T", " ")
}

/**
 * Check if a file exists
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    const file = Bun.file(filePath)
    return await file.exists()
  } catch {
    return false
  }
}

/**
 * Get metadata Python file path
 */
function getMetadataPyPath(dataFilePath: string): string {
  const ext = path.extname(dataFilePath)
  const baseName = path.basename(dataFilePath, ext)
  const dir = path.dirname(dataFilePath)
  return path.join(dir, `${baseName}_metadata.py`)
}

/**
 * Generate Python metadata class content
 */
function generatePythonMetadata(metadata: DataFileMetadata): string {
  const lines: string[] = []

  lines.push(`from typing import List, Dict, Any, Type`)
  lines.push(``)
  lines.push(``)
  lines.push(`class ${toPythonClassName(metadata.file_name)}Metadata:`)
  lines.push(`    file_name: str = ${JSON.stringify(metadata.file_name)}`)
  lines.push(`    file_path: str = ${JSON.stringify(metadata.file_path)}`)
  lines.push(`    last_modified_time: str = ${JSON.stringify(metadata.last_modified_time)}`)
  lines.push(`    description: str = ${JSON.stringify(metadata.description)}`)
  lines.push(``)
  lines.push(`    originated_from: List[Type['DataFileMetadata']] = []`)
  lines.push(``)
  lines.push(`    table_taxonomy: str = ${JSON.stringify(metadata.table_taxonomy)}`)
  lines.push(``)

  // Generate sheets
  lines.push(`    sheets: List[Dict[str, Any]] = [`)
  for (const sheet of metadata.sheets) {
    lines.push(`        {`)
    lines.push(`            "sheet_name": ${JSON.stringify(sheet.sheet_name)},`)
    lines.push(`            "description": ${JSON.stringify(sheet.description)},`)
    lines.push(`            "shape": ${JSON.stringify(sheet.shape)},`)
    lines.push(`            "columns_desc": {`)
    for (const [colName, colDesc] of Object.entries(sheet.columns_desc)) {
      const desc = colDesc as ColumnDesc
      lines.push(`                ${JSON.stringify(colName)}: {`)
      lines.push(`                    "description": ${JSON.stringify(desc.description)},`)
      lines.push(`                    "dataType": ${JSON.stringify(desc.dataType)},`)
      lines.push(`                    "cohesiveness": ${JSON.stringify(desc.cohesiveness)},`)
      lines.push(`                    "uniqueCount": ${desc.uniqueCount},`)
      lines.push(`                    "nullRatio": ${desc.nullRatio},`)
      if (desc.clusteringHint) {
        lines.push(`                    "clusteringHint": True,`)
      }
      lines.push(`                },`)
    }
    lines.push(`            },`)
    lines.push(`        },`)
  }
  lines.push(`    ]`)

  return lines.join("\n")
}

/**
 * Convert file name to valid Python class name
 */
function toPythonClassName(fileName: string): string {
  const baseName = path.basename(fileName, path.extname(fileName))
  return baseName
    .replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_")
    .replace(/^(\d)/, "_$1")
}

// ==================== Main Tool ====================

export const InitDataMetadataTool = Tool.define("init_data_metadata", {
  description: DESCRIPTION,

  parameters: z.object({
    inputFile: z.string().describe("Input CSV or Excel file path"),
  }),

  async execute(params, ctx) {
    const startTime = Date.now()
    log.info("Starting init data metadata", { inputFile: params.inputFile })

    try {
      const inputPath = path.isAbsolute(params.inputFile)
        ? params.inputFile
        : path.join(process.cwd(), params.inputFile)

      // Check if metadata already exists (check both .py and .json)
      const metadataPyPath = getMetadataPyPath(inputPath)
      const metadataJsonPath = DataFile.getMetadataPath(inputPath)
      if ((await fileExists(metadataPyPath)) || (await fileExists(metadataJsonPath))) {
        const existingPath = (await fileExists(metadataPyPath)) ? metadataPyPath : metadataJsonPath
        log.info("Metadata already exists, skipping generation", { path: existingPath })
        return {
          title: "Metadata Already Exists",
          metadata: {
            path: existingPath,
            sheets: 0,
            columns: 0,
            clusteringHints: 0,
            tableTaxonomy: "Skipped",
            executionTime: "0s",
          },
          output: `Metadata already exists at ${existingPath}. Skipping generation.`,
        }
      }

      // Read all sheets from file
      const sheetsData = await readAllSheets(inputPath)
      const sheetNames = Object.keys(sheetsData)
      log.info("Read input file", { sheets: sheetNames.length })

      if (sheetNames.length === 0) {
        throw new Error("Input file has no sheets")
      }

      const fileName = path.basename(inputPath)

      // Step 1: Calculate stats for ALL sheets first (pure computation, fast)
      const allStats: Record<string, Record<string, ColumnDesc>> = {}
      const nonEmptySheets: string[] = []

      for (const sheetName of sheetNames) {
        const data = sheetsData[sheetName]
        if (data.length === 0) continue
        nonEmptySheets.push(sheetName)
        allStats[sheetName] = calculateSheetStats(data)
        log.info(`Calculated stats for sheet: ${sheetName}`, {
          rows: data.length,
          columns: Object.keys(allStats[sheetName]).length,
        })
      }

      // Step 2: Prepare all LLM calls and execute with concurrency limit
      const totalCalls = 1 + nonEmptySheets.length
      log.info("Starting LLM calls", { calls: totalCalls, concurrency: CONFIG.maxConcurrency })

      // Build task factories (functions that return promises when called)
      const tasks: (() => Promise<{ type: "overview"; data: TableOverview } | { type: "fields"; sheetName: string; fieldDescs: Record<string, string> }>)[] = []

      // Overview task
      tasks.push(() =>
        generateTableOverview(fileName, sheetsData, { abort: ctx.abort }).then((data) => ({
          type: "overview" as const,
          data,
        })),
      )

      // Field description tasks for each sheet
      for (const sheetName of nonEmptySheets) {
        tasks.push(() =>
          generateFieldDescriptionsInBatches(
            sheetsData[sheetName],
            Object.keys(allStats[sheetName]),
            allStats[sheetName],
            { abort: ctx.abort },
          ).then((fieldDescs) => ({
            type: "fields" as const,
            sheetName,
            fieldDescs,
          })),
        )
      }

      // Execute with concurrency limit
      const results = await withConcurrencyLimit(tasks, CONFIG.maxConcurrency)

      // Extract results
      const overviewResult = results.find((r) => r.type === "overview") as { type: "overview"; data: TableOverview }
      const overview = overviewResult?.data || {
        description: `数据文件: ${fileName}`,
        field_relationships: "",
        sheet_relationships: nonEmptySheets.length === 1 ? "单表数据" : `包含${nonEmptySheets.length}个sheet: ${nonEmptySheets.join(", ")}`,
        table_taxonomy: "Fact-Dimension Table",
      }
      const fieldResults = results.filter((r) => r.type === "fields") as { type: "fields"; sheetName: string; fieldDescs: Record<string, string> }[]

      log.info("LLM calls completed")

      // Step 3: Assemble final metadata from parallel results
      const sheets: SheetMetadata[] = []

      for (const sheetName of sheetNames) {
        const data = sheetsData[sheetName]

        // Handle empty sheets
        if (data.length === 0) {
          sheets.push({
            sheet_name: sheetName,
            description: `空表: ${sheetName}`,
            shape: [0, 0],
            columns_desc: {},
          })
          continue
        }

        const stats = allStats[sheetName]
        const fieldResult = fieldResults.find((r) => r.sheetName === sheetName)

        // Merge LLM descriptions into stats
        if (fieldResult) {
          for (const [col, desc] of Object.entries(fieldResult.fieldDescs)) {
            if (stats[col]) {
              stats[col].description = desc
            }
          }
        }

        // First sheet gets the overview description, others get sheet name
        const sheetDescription =
          sheetName === nonEmptySheets[0] ? overview.description : `${sheetName} sheet data`

        sheets.push({
          sheet_name: sheetName,
          description: sheetDescription,
          shape: [data.length, Object.keys(stats).length],
          columns_desc: stats,
        })
      }

      // Combine description + field_relationships + sheet_relationships

      const fullDescription = [
        overview.description,
        overview.field_relationships ? `\n\n字段关系: ${overview.field_relationships}` : "",
        overview.sheet_relationships ? `\n\n表关系: ${overview.sheet_relationships}` : "",
      ].join("")

      const metadata: DataFileMetadata = {
        file_name: fileName,
        file_path: inputPath,
        last_modified_time: formatCST(new Date()),
        description: fullDescription,
        originated_from: [],
        table_taxonomy: overview.table_taxonomy,
        sheets,
      }

      const pythonContent = generatePythonMetadata(metadata)
      await Bun.write(metadataPyPath, pythonContent)

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.info("Init data metadata completed", { executionTime: `${executionTime}s` })

      const totalColumns = sheets.reduce((sum, s) => sum + Object.keys(s.columns_desc).length, 0)
      const clusteringHintCount = sheets.reduce(
        (sum, s) =>
          sum + Object.values(s.columns_desc).filter((c) => c.clusteringHint).length,
        0,
      )

      const outputMessage = `Metadata generated successfully.
- Output: ${metadataPyPath}
- Sheets: ${sheets.length}
- Total columns: ${totalColumns}
- Columns with clustering hint: ${clusteringHintCount}
- Table taxonomy: ${metadata.table_taxonomy}
- Execution time: ${executionTime}s`

      return {
        title: "Metadata Initialized",
        metadata: {
          path: metadataPyPath,
          sheets: sheets.length,
          columns: totalColumns,
          clusteringHints: clusteringHintCount,
          tableTaxonomy: metadata.table_taxonomy,
          executionTime: `${executionTime}s`,
        },
        output: outputMessage,
      }
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.error("Init data metadata failed", { error, executionTime: `${executionTime}s` })
      throw error
    }
  },
})
