import { authorize } from './auth.js';
import { EmailAnalyzer } from './emailAnalyzer.js';
import { EmailFilter } from './emailFilter.js';
import { loadCheckpoint, updateCheckpoint } from './checkpoint.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import readline from 'readline/promises';

dotenv.config();

async function getConfig() {
  const vipEmails = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',').map(e => e.trim()) : [];
  const protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim()) : [];
  const protectedKeywords = process.env.PROTECTED_KEYWORDS ? process.env.PROTECTED_KEYWORDS.split(',').map(k => k.trim()) : [];
  
  return { vipEmails, protectedSenders, protectedKeywords };
}

async function processNewEmails(auth, config) {
  const checkpoint = await loadCheckpoint();
  const analyzer = new EmailAnalyzer(auth, config.vipEmails, config.protectedSenders, config.protectedKeywords);
  
  let messages;
  if (checkpoint.lastProcessedDate) {
    // Fetch only emails after the last processed date
    console.log(chalk.cyan(`📧 Fetching emails since ${checkpoint.lastProcessedDate}...`));
    messages = await analyzer.fetchEmailsSince(checkpoint.lastProcessedDate, 500);
  } else {
    // First run - fetch recent emails
    console.log(chalk.cyan('📧 First run - fetching recent 500 emails...'));
    messages = await analyzer.fetchEmails(500);
  }

  if (messages.length === 0) {
    console.log(chalk.yellow('No new emails to process!'));
    return { processed: 0, hasMore: false };
  }

  console.log(chalk.cyan(`🔍 Analyzing ${messages.length} emails...`));
  const analysisResults = await analyzer.analyzeAllEmails(messages);
  
  analyzer.displaySummary();
  await analyzer.saveAnalysisResults();

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const proceed = await rl.question('\n' + chalk.yellow('Apply filtering rules? (y/n): '));
  
  if (proceed.toLowerCase() === 'y') {
    const filter = new EmailFilter(auth);
    
    console.log(chalk.cyan('\n🏷️  Setting up labels...'));
    const labels = await filter.setupFilteringLabels();
    
    console.log(chalk.cyan('⚡ Applying filters...'));
    await filter.applyFiltersToExisting(analysisResults, labels);
    
    console.log(chalk.cyan('📝 Creating filter rules...'));
    await filter.createFilters(analysisResults, labels);
    
    filter.displayFilteringSummary(analysisResults);
    
    // Update checkpoint with current date
    const now = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    await updateCheckpoint({
      lastProcessedDate: now,
      totalProcessed: checkpoint.totalProcessed + messages.length
    });
    
    console.log(chalk.green('\n✅ Filtering complete!'));
    console.log(chalk.gray(`Checkpoint saved. Next run will fetch emails after ${now}`));
  }
  
  rl.close();
  return { processed: messages.length, hasMore: messages.length === 500 };
}

async function main() {
  console.log(chalk.bold.cyan('\n🚀 Gmail Continuous Email Filter\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const config = await getConfig();
    console.log(chalk.green(`✅ ${config.vipEmails.length} VIP emails configured`));
    console.log(chalk.green(`✅ ${config.protectedSenders.length} protected senders configured`));
    console.log(chalk.green(`✅ ${config.protectedKeywords.length} protected keywords configured\n`));

    const checkpoint = await loadCheckpoint();
    if (checkpoint.lastProcessedDate) {
      console.log(chalk.cyan(`📅 Last processed: ${checkpoint.lastProcessedDate}`));
      console.log(chalk.cyan(`📊 Total processed: ${checkpoint.totalProcessed} emails\n`));
    }

    let continueProcessing = true;
    
    while (continueProcessing) {
      const result = await processNewEmails(auth, config);
      
      if (result.hasMore) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await rl.question('\n' + chalk.yellow('More emails available. Continue processing? (y/n): '));
        continueProcessing = answer.toLowerCase() === 'y';
        rl.close();
      } else {
        continueProcessing = false;
      }
    }
    
    console.log(chalk.green('\n✅ All done!'));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();