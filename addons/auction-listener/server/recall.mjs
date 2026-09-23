const regions=new Set(['us-west-2','us-east-1','eu-central-1','ap-northeast-1']);
export function readRecallConfig(env=process.env) {
  const region=env.RECALL_REGION || 'us-west-2';
  if (!regions.has(region)) throw new Error('Unsupported Recall region.');
  return { apiKey:env.RECALL_API_KEY || '', apiUrl:`https://${region}.recall.ai`, webhookSecret:env.RECALL_WEBHOOK_VERIFICATION_SECRET || '' };
}
export class RecallClient {
  constructor(config, fetcher=fetch) { this.config=config; this.fetcher=fetcher; }
  async request(path, body) {
    if (!this.config.apiKey) throw new Error('Recall API key is not configured. Run the private setup step first.');
    const response=await this.fetcher(`${this.config.apiUrl}/api/v1/${path}`, {
      method:body?'POST':'GET', headers:{Authorization:`Token ${this.config.apiKey}`,'Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{}), signal:AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      // Never include response bodies/headers in errors: they may contain secrets.
      const retry=response.headers.get('retry-after');
      throw new Error(response.status===429 ? `Recall is busy. Retry after ${/^\d+$/.test(retry??'')?retry:'60'} seconds.` : `Recall request failed (HTTP ${response.status}). Check API access and billing in Recall.`);
    }
    return response.json();
  }
  createUpload(sessionId) {
    // No automatic retry on creation: a timeout can mean Recall already created it.
    return this.request('sdk_upload/', {
      metadata:{application:'calcutta-listener-v0',session_id:sessionId},
      recording_config:{
        video_mixed_mp4:null, audio_mixed_mp3:{},
        transcript:{provider:{recallai_streaming:{mode:'prioritize_low_latency',language_code:'en'}}},
        realtime_endpoints:[{type:'desktop_sdk_callback',events:['transcript.data','transcript.partial_data']}],
      },
    });
  }
  getUpload(id) {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid recording ID.');
    return this.request(`sdk_upload/${id}/`);
  }
}
