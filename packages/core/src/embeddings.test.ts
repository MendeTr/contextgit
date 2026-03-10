import { describe, it, expect, vi } from 'vitest'
import { EmbeddingService } from './embeddings.js'

// Fake pipeline that returns a predictable 384-dim vector
function makeFakePipeline() {
  return async (_text: string, _opts: unknown) => ({
    data: new Float32Array(384).fill(0.5),
  })
}

function makeBrokenPipeline() {
  return Promise.reject(new Error('model load failed'))
}

describe('EmbeddingService', () => {
  it('returns a Float32Array of length 384 on success', async () => {
    const svc = new EmbeddingService({
      pipelineFactory: async () => makeFakePipeline(),
    })
    const vec = await svc.embed('hello world')
    expect(vec).toBeInstanceOf(Float32Array)
    expect(vec!.length).toBe(384)
  })

  it('returns null when pipeline load fails', async () => {
    const svc = new EmbeddingService({
      pipelineFactory: async () => { throw new Error('load error') },
    })
    const vec = await svc.embed('hello')
    expect(vec).toBeNull()
  })

  it('returns null when pipeline call throws', async () => {
    const svc = new EmbeddingService({
      pipelineFactory: async () => {
        return async () => { throw new Error('inference error') }
      },
    })
    const vec = await svc.embed('hello')
    expect(vec).toBeNull()
  })

  it('never throws — always returns null on any error', async () => {
    const svc = new EmbeddingService({
      pipelineFactory: () => makeBrokenPipeline() as never,
    })
    await expect(svc.embed('anything')).resolves.toBeNull()
  })

  it('loads the pipeline only once across multiple embeds', async () => {
    const factory = vi.fn(async () => makeFakePipeline())
    const svc = new EmbeddingService({ pipelineFactory: factory })
    await svc.embed('a')
    await svc.embed('b')
    await svc.embed('c')
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
