import os
from dotenv import load_dotenv
from openai import OpenAI
load_dotenv(override=True)

client = OpenAI(base_url="https://integrate.api.nvidia.com/v1", api_key=os.getenv("NVIDIA_API_KEY"))
r = client.chat.completions.create(
    model="nvidia/nemotron-3-super-120b-a12b",
    messages=[{"role": "user", "content": "say hi"}],
    max_tokens=1000,
)
m = r.choices[0]
print("finish_reason:", m.finish_reason)
print("content:", m.message.content)
print("reasoning:", getattr(m.message, "reasoning_content", None))