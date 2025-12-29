/**
 * City Tagging Tool
 *
 * City name standardization and enrichment tool.
 * Matches city names against a predefined configuration and enriches data
 * with standardized city, province, tier, and region fields.
 */

import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { DataFile } from "../util/datafile"
import { Log } from "../util/log"
import DESCRIPTION from "./city-tagging.txt"
import cityTagConf from "../data/city-tag-conf.json"

const log = Log.create({ service: "tool.city-tagging" })

interface CityInfo {
  province: string
  alias: string[]
  city_tier: string
  region: string
}

interface CityMatch {
  standardized_city: string
  standardized_province: string
  standardized_city_tier: string
  standardized_geo_region: string
}

type MatchingRule = [string, string, CityInfo] // [pattern, cityName, cityInfo]

// Build matching rules sorted by pattern length (descending)
// This ensures longer patterns are matched first to avoid ambiguity
function buildMatchingRules(): MatchingRule[] {
  const rules: MatchingRule[] = []
  const conf = cityTagConf as Record<string, CityInfo>

  for (const [cityName, cityInfo] of Object.entries(conf)) {
    // Add the city name itself as a pattern
    rules.push([cityName, cityName, cityInfo])
    // Add all aliases
    for (const alias of cityInfo.alias || []) {
      rules.push([alias, cityName, cityInfo])
    }
  }

  // Sort by pattern length descending (longer patterns first)
  rules.sort((a, b) => b[0].length - a[0].length)
  return rules
}

// Pre-build matching rules at module load time
const matchingRules = buildMatchingRules()

function matchCities(text: string): CityMatch[] {
  if (!text) return []

  const matched: CityMatch[] = []
  const matchedCityNames = new Set<string>()
  let remainingText = String(text)

  for (const [pattern, cityName, cityInfo] of matchingRules) {
    // Skip if this city was already matched by a longer pattern
    if (matchedCityNames.has(cityName)) continue

    if (remainingText.includes(pattern)) {
      matched.push({
        standardized_city: cityName,
        standardized_province: cityInfo.province,
        standardized_city_tier: cityInfo.city_tier,
        standardized_geo_region: cityInfo.region,
      })
      matchedCityNames.add(cityName)
      // Remove matched pattern to avoid shorter alias matching same city
      remainingText = remainingText.replace(pattern, "")
    }
  }

  return matched
}

export const CityTaggingTool = Tool.define("city_tagging", {
  description: DESCRIPTION,

  parameters: z.object({
    inputFile: z.string().describe("Input CSV or Excel file path"),
    cityColumn: z.string().describe("Column name containing city names to match"),
    primaryKey: z.string().describe("Primary key column name to preserve in output"),
    outputFile: z.string().describe("Output file path (will add _城市标签明细表 suffix)"),
  }),

  async execute(params, ctx) {
    const startTime = Date.now()
    log.info("Starting city tagging", {
      inputFile: params.inputFile,
      outputFile: params.outputFile,
      cityColumn: params.cityColumn,
      primaryKey: params.primaryKey,
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

      // Validate columns exist
      const columns = Object.keys(data[0] || {})
      if (!columns.includes(params.cityColumn)) {
        throw new Error(
          `City column '${params.cityColumn}' not found in file. Available columns: ${columns.join(", ")}`
        )
      }
      if (!columns.includes(params.primaryKey)) {
        throw new Error(
          `Primary key column '${params.primaryKey}' not found in file. Available columns: ${columns.join(", ")}`
        )
      }

      // Match cities and collect results
      const matchStats = {
        totalRows: data.length,
        matchedRows: 0,
        unmatchedRows: 0,
        multiMatchRows: 0,
        totalOutputRows: 0,
      }

      const resultRows: Record<string, string>[] = []

      for (const row of data) {
        const cityText = row[params.cityColumn] ?? ""
        const matchedCities = matchCities(cityText)

        if (matchedCities.length > 0) {
          matchStats.matchedRows++
          if (matchedCities.length > 1) {
            matchStats.multiMatchRows++
          }

          // Create one row per matched city (explode pattern)
          for (const cityMatch of matchedCities) {
            resultRows.push({
              [params.primaryKey]: row[params.primaryKey],
              [params.cityColumn]: row[params.cityColumn],
              ...cityMatch,
            })
          }
        } else {
          // No match - keep row with empty standardized fields
          matchStats.unmatchedRows++
          resultRows.push({
            [params.primaryKey]: row[params.primaryKey],
            [params.cityColumn]: row[params.cityColumn],
            standardized_city: "",
            standardized_province: "",
            standardized_city_tier: "",
            standardized_geo_region: "",
          })
        }
      }

      matchStats.totalOutputRows = resultRows.length

      log.info("City matching completed", {
        matched: matchStats.matchedRows,
        unmatched: matchStats.unmatchedRows,
        multiMatch: matchStats.multiMatchRows,
        outputRows: matchStats.totalOutputRows,
      })

      // Compute output file paths with proper naming convention
      const ext = path.extname(params.outputFile)
      const baseName = params.outputFile.slice(0, -ext.length)
      const mainOutputFileName = `${baseName}_城市标签明细表${ext}`
      const outputPath = path.isAbsolute(mainOutputFileName)
        ? mainOutputFileName
        : path.join(process.cwd(), mainOutputFileName)

      await DataFile.write(outputPath, resultRows)
      log.info("Wrote output file", { path: outputPath, rows: resultRows.length })

      // Write metadata as Python class file
      const metadataPyPath = DataFile.getMetadataPyPath(outputPath)
      const metadataPy = DataFile.generateClusteringMetadataPy({
        file_name: path.basename(outputPath),
        file_path: outputPath,
        description: `城市标签化结果，基于${params.cityColumn}字段匹配城市信息`,
        originated_from: params.inputFile,
        generate_process: [
          {
            stepName: "城市匹配",
            detailProcessDescription: `将城市列与城市配置库进行匹配，匹配规则优先选择长度较长的城市名或别名以避免歧义，共匹配${matchStats.matchedRows}行，未匹配${matchStats.unmatchedRows}行`,
            type: "Transform",
            inputColumns: [params.cityColumn],
            resultShape: `(${matchStats.totalRows}, 6)`,
          },
          {
            stepName: "多匹配拆分",
            detailProcessDescription: `一行数据匹配到多个城市时拆分为多行，共有${matchStats.multiMatchRows}行匹配到多个城市`,
            type: "Explode",
            inputColumns: [params.cityColumn],
            resultShape: `(${resultRows.length}, 6)`,
          },
          {
            stepName: "字段扩展",
            detailProcessDescription:
              "为每个匹配城市添加标准化城市名(standardized_city)、省份(standardized_province)、城市等级(standardized_city_tier)、地理区域(standardized_geo_region)四个字段",
            type: "Map",
            inputColumns: ["standardized_city"],
            resultShape: `(${resultRows.length}, 6)`,
          },
        ],
        table_taxonomy: "Fact-Dimension Table",
        columns_desc: {
          [params.primaryKey]: "主键",
          [params.cityColumn]: "原始城市列",
          standardized_city: "标准化城市名",
          standardized_province: "所属省份",
          standardized_city_tier: "城市等级（一线/新一线/二线/三线/四线/五线）",
          standardized_geo_region: "地理区域（华北/华东/华南/华中/西南/西北/东北）",
        },
      })
      await Bun.write(metadataPyPath, metadataPy)

      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.info("City tagging completed", { executionTime: `${executionTime}s` })

      const outputMessage = `City tagging completed successfully.
- Matched: ${matchStats.matchedRows}/${matchStats.totalRows} rows
- Multi-match: ${matchStats.multiMatchRows} rows matched multiple cities
- Output: ${mainOutputFileName} (${resultRows.length} rows)
- Execution time: ${executionTime}s`

      return {
        title: "City Tagging",
        metadata: {
          inputFile: params.inputFile,
          outputFile: mainOutputFileName,
          matchedRows: matchStats.matchedRows,
          unmatchedRows: matchStats.unmatchedRows,
          multiMatchRows: matchStats.multiMatchRows,
          outputRows: resultRows.length,
          executionTime: `${executionTime}s`,
          error: undefined as string | undefined,
        },
        output: outputMessage,
      }
    } catch (error) {
      const executionTime = ((Date.now() - startTime) / 1000).toFixed(2)
      log.error("City tagging failed", { error, executionTime: `${executionTime}s` })

      return {
        title: "City Tagging Failed",
        metadata: {
          inputFile: params.inputFile,
          outputFile: "",
          matchedRows: 0,
          unmatchedRows: 0,
          multiMatchRows: 0,
          outputRows: 0,
          executionTime: `${executionTime}s`,
          error: String(error),
        },
        output: `City tagging failed: ${error}`,
      }
    }
  },
})
