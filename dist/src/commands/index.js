import { SkillsService } from '../services/skills/skillsService.js';
export async function handleCommand(input, session) {
    const trimmed = input.trim();
    if (trimmed === '/exit' || trimmed === '/quit') {
        return { type: 'exit' };
    }
    if (trimmed === '/clear') {
        session.messages = [];
        console.log('Conversation cleared.');
        return { type: 'continue' };
    }
    if (trimmed === '/help') {
        console.log(`
Available commands:
  /help           Show this help message
  /clear          Clear conversation history
  /skills list    List all available skills
  /exit, /quit    Exit the CLI
    `.trim());
        return { type: 'continue' };
    }
    if (trimmed === '/skills list') {
        const skills = await new SkillsService(session.cwd).list();
        if (skills.length === 0) {
            console.log('No skills available.');
        }
        else {
            console.log(`\nAvailable skills (${skills.length}):`);
            for (const skill of skills) {
                console.log(`  ${skill.name} - ${skill.description}`);
            }
        }
        return { type: 'continue' };
    }
    // Unknown command
    console.log(`Unknown command: ${trimmed}. Type /help for available commands.`);
    return { type: 'continue' };
}
