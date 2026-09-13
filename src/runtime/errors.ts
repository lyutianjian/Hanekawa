export type RuntimeStartupErrorCode =
  | 'invalid_settings'
  | 'no_default_model'
  | 'unknown_model'
  | 'provider_creation_failed'

export interface RuntimeConfigurationIssue {
  code: Exclude<RuntimeStartupErrorCode, 'invalid_settings'>
  message: string
}

export const MODEL_CONFIGURATION_REQUIRED = '请先在“模型与服务商”设置或 /provider 中配置可用模型。'

export const MISSING_MODEL_ISSUE: RuntimeConfigurationIssue = {
  code: 'no_default_model',
  message: '尚未配置可用的默认模型。',
}

/**
 * Thrown instead of exiting the process, so any host (TUI, desktop shell,
 * tests) decides how to surface it. Model configuration errors leave the shell
 * running in its configuration state; invalid settings still fail startup.
 */
export class RuntimeStartupError extends Error {
  readonly code: RuntimeStartupErrorCode

  constructor(code: RuntimeStartupErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeStartupError'
    this.code = code
  }
}
