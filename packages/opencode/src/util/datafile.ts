/**
 * Data File Utility Module
 *
 * Provides CSV and Excel file parsing/writing utilities for clustering tools.
 */

import * as XLSX from "xlsx"
import path from "path"

export namespace DataFile {
  /**
   * Read CSV or Excel file, auto-detect by extension
   * @param filePath - Path to the file to read
   * @returns Array of records with string values
   */
  export async function read(filePath: string): Promise<Record<string, string>[]> {
    const ext = path.extname(filePath).toLowerCase()
    const file = Bun.file(filePath)

    if (!(await file.exists())) {
      throw new Error(`File not found: ${filePath}`)
    }

    if (ext === ".csv") {
      return readCSV(await file.text())
    } else if (ext === ".xlsx" || ext === ".xls") {
      return readExcel(await file.arrayBuffer())
    } else {
      throw new Error(`Unsupported file format: ${ext}. Supported formats: .csv, .xlsx, .xls`)
    }
  }

  /**
   * Write data to CSV or Excel file, auto-detect by extension
   * @param filePath - Path to the file to write
   * @param data - Array of records to write
   * @param columns - Optional column order (defaults to keys of first record)
   */
  export async function write(
    filePath: string,
    data: Record<string, string>[],
    columns?: string[],
  ): Promise<void> {
    const ext = path.extname(filePath).toLowerCase()

    if (ext === ".csv") {
      const content = stringifyCSV(data, columns)
      await Bun.write(filePath, content)
    } else if (ext === ".xlsx" || ext === ".xls") {
      const buffer = writeExcel(data, columns)
      await Bun.write(filePath, buffer)
    } else {
      throw new Error(`Unsupported file format: ${ext}. Supported formats: .csv, .xlsx, .xls`)
    }
  }

  /**
   * Write metadata JSON file
   * @param filePath - Path to the metadata file
   * @param metadata - Metadata object to write
   */
  export async function writeMetadata(filePath: string, metadata: object): Promise<void> {
    await Bun.write(filePath, JSON.stringify(metadata, null, 2))
  }

  // ==================== CSV Functions ====================

  /**
   * Parse CSV content into array of records
   */
  function readCSV(content: string): Record<string, string>[] {
    const lines = parseCSVLines(content)
    if (lines.length === 0) return []

    const headers = lines[0]
    const records: Record<string, string>[] = []

    for (let i = 1; i < lines.length; i++) {
      const values = lines[i]
      const record: Record<string, string> = {}

      for (let j = 0; j < headers.length; j++) {
        record[headers[j]] = values[j] ?? ""
      }

      records.push(record)
    }

    return records
  }

  /**
   * Parse CSV content into array of arrays, handling quoted fields
   */
  function parseCSVLines(content: string): string[][] {
    const lines: string[][] = []
    let currentLine: string[] = []
    let currentField = ""
    let inQuotes = false

    for (let i = 0; i < content.length; i++) {
      const char = content[i]
      const nextChar = content[i + 1]

      if (inQuotes) {
        if (char === '"' && nextChar === '"') {
          // Escaped quote
          currentField += '"'
          i++ // Skip next quote
        } else if (char === '"') {
          // End of quoted field
          inQuotes = false
        } else {
          currentField += char
        }
      } else {
        if (char === '"') {
          // Start of quoted field
          inQuotes = true
        } else if (char === ",") {
          // Field separator
          currentLine.push(currentField)
          currentField = ""
        } else if (char === "\r" && nextChar === "\n") {
          // CRLF line ending
          currentLine.push(currentField)
          currentField = ""
          if (currentLine.length > 0 && currentLine.some((f) => f !== "")) {
            lines.push(currentLine)
          }
          currentLine = []
          i++ // Skip LF
        } else if (char === "\n") {
          // LF line ending
          currentLine.push(currentField)
          currentField = ""
          if (currentLine.length > 0 && currentLine.some((f) => f !== "")) {
            lines.push(currentLine)
          }
          currentLine = []
        } else {
          currentField += char
        }
      }
    }

    // Handle last field
    if (currentField !== "" || currentLine.length > 0) {
      currentLine.push(currentField)
      if (currentLine.some((f) => f !== "")) {
        lines.push(currentLine)
      }
    }

    return lines
  }

  /**
   * Stringify records to CSV format
   */
  function stringifyCSV(data: Record<string, string>[], columns?: string[]): string {
    if (data.length === 0) return ""

    const headers = columns ?? Object.keys(data[0])
    const lines: string[] = []

    // Header row
    lines.push(headers.map(escapeCSVField).join(","))

    // Data rows
    for (const record of data) {
      const row = headers.map((h) => escapeCSVField(record[h] ?? ""))
      lines.push(row.join(","))
    }

    return lines.join("\n")
  }

  /**
   * Escape a field for CSV (quote if necessary)
   */
  function escapeCSVField(value: string): string {
    if (value.includes(",") || value.includes('"') || value.includes("\n") || value.includes("\r")) {
      return '"' + value.replace(/"/g, '""') + '"'
    }
    return value
  }

  // ==================== Excel Functions ====================

  /**
   * Read Excel file into array of records
   */
  function readExcel(buffer: ArrayBuffer): Record<string, string>[] {
    const workbook = XLSX.read(buffer, { type: "array" })
    const firstSheetName = workbook.SheetNames[0]
    const worksheet = workbook.Sheets[firstSheetName]

    // Convert to JSON with header row
    const jsonData = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      raw: false,
      defval: "",
    }) as unknown[][]

    if (jsonData.length === 0) return []

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

    return records
  }

  /**
   * Write records to Excel buffer
   */
  function writeExcel(data: Record<string, string>[], columns?: string[]): Uint8Array {
    const headers = columns ?? (data.length > 0 ? Object.keys(data[0]) : [])

    // Create worksheet data
    const wsData: string[][] = [headers]

    for (const record of data) {
      const row = headers.map((h) => record[h] ?? "")
      wsData.push(row)
    }

    // Create workbook and worksheet
    const worksheet = XLSX.utils.aoa_to_sheet(wsData)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Sheet1")

    // Write to buffer
    return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as Uint8Array
  }

  // ==================== Utility Functions ====================

  /**
   * Generate metadata file path from data file path (JSON format)
   * @param dataFilePath - Path to the data file
   * @returns Path for the metadata JSON file
   */
  export function getMetadataPath(dataFilePath: string): string {
    const ext = path.extname(dataFilePath)
    const baseName = dataFilePath.slice(0, -ext.length)
    return `${baseName}_metadata.json`
  }

  /**
   * Generate metadata Python file path from data file path
   * @param dataFilePath - Path to the data file
   * @returns Path for the metadata Python file
   */
  export function getMetadataPyPath(dataFilePath: string): string {
    const ext = path.extname(dataFilePath)
    const baseName = dataFilePath.slice(0, -ext.length)
    return `${baseName}_metadata.py`
  }

  /**
   * Convert file name to valid Python class name
   */
  export function toPythonClassName(fileName: string): string {
    const baseName = path.basename(fileName, path.extname(fileName))
    return baseName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, "_").replace(/^(\d)/, "_$1")
  }

  /**
   * Format date in CST timezone (UTC+8)
   */
  function formatCST(date: Date): string {
    const cst = new Date(date.getTime() + 8 * 60 * 60 * 1000)
    return cst.toISOString().slice(0, 19).replace("T", " ")
  }

  /**
   * Generate Python metadata class content for clustering tools
   */
  export function generateClusteringMetadataPy(metadata: {
    file_name: string
    file_path: string
    description: string
    originated_from: string
    generate_process: Array<{
      stepName: string
      detailProcessDescription: string
      type: string
      inputColumns: string[]
      resultShape: string
    }>
    table_taxonomy: string
    columns_desc: Record<string, string>
    extra_fields?: Record<string, unknown>
  }): string {
    const lines: string[] = []
    const className = toPythonClassName(metadata.file_name)
    const now = formatCST(new Date())

    lines.push(`from typing import List, Dict, Any, Type`)
    lines.push(``)
    lines.push(``)
    lines.push(`class ${className}Metadata:`)
    lines.push(`    file_name: str = ${JSON.stringify(metadata.file_name)}`)
    lines.push(`    file_path: str = ${JSON.stringify(metadata.file_path)}`)
    lines.push(`    last_modified_time: str = ${JSON.stringify(now)}`)
    lines.push(`    description: str = ${JSON.stringify(metadata.description)}`)
    lines.push(``)
    lines.push(`    originated_from: List[Type['DataFileMetadata']] = []`)
    lines.push(``)
    lines.push(`    generate_process: List[Dict[str, Any]] = [`)
    for (const step of metadata.generate_process) {
      lines.push(`        {`)
      lines.push(`            "stepName": ${JSON.stringify(step.stepName)},`)
      lines.push(`            "detailProcessDescription": ${JSON.stringify(step.detailProcessDescription)},`)
      lines.push(`            "type": ${JSON.stringify(step.type)},`)
      lines.push(`            "inputColumns": ${JSON.stringify(step.inputColumns)},`)
      lines.push(`            "resultShape": ${JSON.stringify(step.resultShape)},`)
      lines.push(`        },`)
    }
    lines.push(`    ]`)
    lines.push(``)
    lines.push(`    table_taxonomy: str = ${JSON.stringify(metadata.table_taxonomy)}`)
    lines.push(``)

    // Generate sheets with columns_desc
    const columns = Object.keys(metadata.columns_desc)
    lines.push(`    sheets: List[Dict[str, Any]] = [`)
    lines.push(`        {`)
    lines.push(`            "sheet_name": "Sheet1",`)
    lines.push(`            "description": ${JSON.stringify(metadata.description)},`)
    // Extract shape from last generate_process resultShape
    const lastStep = metadata.generate_process[metadata.generate_process.length - 1]
    const shapeMatch = lastStep?.resultShape?.match(/\((\d+),\s*(\d+)\)/)
    const shape = shapeMatch ? [parseInt(shapeMatch[1]), parseInt(shapeMatch[2])] : [0, columns.length]
    lines.push(`            "shape": ${JSON.stringify(shape)},`)
    lines.push(`            "columns_desc": {`)
    for (const [colName, colDesc] of Object.entries(metadata.columns_desc)) {
      lines.push(`                ${JSON.stringify(colName)}: {`)
      lines.push(`                    "description": ${JSON.stringify(colDesc)},`)
      lines.push(`                },`)
    }
    lines.push(`            },`)
    lines.push(`        },`)
    lines.push(`    ]`)

    // Add extra fields if provided
    if (metadata.extra_fields) {
      lines.push(``)
      for (const [key, value] of Object.entries(metadata.extra_fields)) {
        if (typeof value === "object") {
          lines.push(`    ${key}: Dict[str, Any] = ${JSON.stringify(value, null, 8).split("\n").join("\n    ")}`)
        } else {
          lines.push(`    ${key}: Any = ${JSON.stringify(value)}`)
        }
      }
    }

    return lines.join("\n")
  }

  /**
   * Limit output columns to max count, prioritizing specified columns
   * @param data - Array of records
   * @param outputLabelColumn - The output label column (always kept)
   * @param priorityColumns - Columns to prioritize keeping
   * @param maxColumns - Maximum number of columns (excluding user_id and output)
   * @returns Filtered data with limited columns
   */
  export function limitOutputColumns(
    data: Record<string, string>[],
    outputLabelColumn: string,
    priorityColumns: string[],
    maxColumns: number = 10,
  ): Record<string, string>[] {
    if (data.length === 0) return data

    const currentColumns = Object.keys(data[0])

    // Separate special columns (user_id and output)
    const specialColumns: string[] = []
    if (currentColumns.includes("user_id")) specialColumns.push("user_id")
    if (currentColumns.includes(outputLabelColumn)) specialColumns.push(outputLabelColumn)

    // Get existing priority columns (in order)
    const existingPriorityColumns = priorityColumns.filter(
      (col) => currentColumns.includes(col) && !specialColumns.includes(col),
    )

    // Get other columns (excluding special and priority)
    const otherColumns = currentColumns.filter(
      (col) => !specialColumns.includes(col) && !existingPriorityColumns.includes(col),
    )

    // Calculate quota for other columns
    const otherQuota = Math.max(0, maxColumns - existingPriorityColumns.length)

    // Limit other columns
    const limitedOtherColumns = otherColumns.slice(0, otherQuota)

    // Build final column order: user_id (if exists) + priority + other + output
    const finalColumns: string[] = []
    if (specialColumns.includes("user_id")) finalColumns.push("user_id")
    finalColumns.push(...existingPriorityColumns)
    finalColumns.push(...limitedOtherColumns)
    if (specialColumns.includes(outputLabelColumn)) finalColumns.push(outputLabelColumn)

    // Filter data to only include final columns
    return data.map((record) => {
      const filtered: Record<string, string> = {}
      for (const col of finalColumns) {
        filtered[col] = record[col] ?? ""
      }
      return filtered
    })
  }
}
