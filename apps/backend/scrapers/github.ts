import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

export async function scrapeGithub(username: string) {
    const config: Record<string, any> = {
        url: `https://api.github.com/users/${username}/repos`,
        headers: {
            "Accept": "application/vnd.github+json",
            ...(process.env.GITHUB_TOKEN
                ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
                : {})
        }
    };

    // Only use proxy if explicitly configured
    if (process.env.PROXY_URL) {
        config.httpsAgent = new HttpsProxyAgent(process.env.PROXY_URL);
    }

    const response = await axios.request(config);

    if (!Array.isArray(response.data)) {
        throw new Error(`GitHub returned unexpected response for user: ${username}`);
    }

    return response.data.map((x: any) => ({
        description: x.description,
        name: x.name,
        fullName: x.full_name,
        language: x.language,
        starCount: x.stargazers_count,
        topics: x.topics ?? []
    }));
}