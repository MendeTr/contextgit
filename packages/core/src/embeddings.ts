// EmbeddingService — generates 384-dim sentence embeddings using
// @xenova/transformers (all-MiniLM-L6-v2, runs fully local, no API key).
//
// Usage:
//   const svc = new EmbeddingService()
//   const vector = await svc.embed('some text')   // Float32Array | null
//
// Load failure is silently swallowed — callers receive null and should fall
// back to full-text search.  Never let embedding errors propagate outward.

type PipelineFn = (text: string, options: { pooling: string; normalize: boolean }) => Promise<{ data: Float32Array }>

export interface EmbeddingServiceOptions {
  /** Override the pipeline factory — for tests. */
  pipelineFactory?: (task: string, model: string) => Promise<PipelineFn>
}

export class EmbeddingService {
  private pipeline: PipelineFn | null = null
  private loadPromise: Promise<void> | null = null
  private readonly pipelineFactory: (task: string, model: string) => Promise<PipelineFn>

  static readonly MODEL = 'Xenova/all-MiniLM-L6-v2'
  static readonly DIMS  = 384

  constructor(options: EmbeddingServiceOptions = {}) {
    this.pipelineFactory = options.pipelineFactory ?? EmbeddingService.defaultPipelineFactory
  }

  /**
   * Generate a 384-dim embedding for `text`.
   * Returns null if the model is unavailable or any error occurs.
   */
  async embed(text: string): Promise<Float32Array | null> {
    try {
      await this.ensureLoaded()
      if (!this.pipeline) return null
      const result = await this.pipeline(text, { pooling: 'mean', normalize: true })
      return result.data
    } catch {
      return null
    }
  }

  /** True once the model has been loaded at least once (even if it failed). */
  get isReady(): boolean {
    return this.loadPromise !== null
  }

  private async ensureLoaded(): Promise<void> {
    if (this.pipeline) return
    if (!this.loadPromise) {
      this.loadPromise = this.load()
    }
    await this.loadPromise
  }

  private async load(): Promise<void> {
    try {
      this.pipeline = await this.pipelineFactory('feature-extraction', EmbeddingService.MODEL)
    } catch {
      this.pipeline = null
    }
  }

  private static async defaultPipelineFactory(_task: string, model: string): Promise<PipelineFn> {
    // Dynamic import so the heavy @xenova/transformers bundle is only loaded
    // when embeddings are actually needed.
    const { pipeline } = await import('@xenova/transformers')
    // Cast task to any to avoid strict PipelineType enum mismatch — we always
    // pass 'feature-extraction' which is valid at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return pipeline('feature-extraction' as any, model) as unknown as PipelineFn
  }
}
