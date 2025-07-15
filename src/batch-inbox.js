import { authorize } from './auth.js';
import { EmailAnalyzer } from './emailAnalyzer.js';
import { EmailFilter } from './emailFilter.js';
import chalk from 'chalk';
import ora from 'ora';
import dotenv from 'dotenv';
import readline from 'readline/promises';
import { google } from 'googleapis';

dotenv.config();

async function getConfig() {
  const vipEmails = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',').map(e => e.trim()) : [];
  const protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim()) : [];
  const protectedKeywords = process.env.PROTECTED_KEYWORDS ? process.env.PROTECTED_KEYWORDS.split(',').map(k => k.trim()) : [];
  
  return { vipEmails, protectedSenders, protectedKeywords };
}

async function fetchInboxEmails(gmail, batchSize = 500, pageToken = null) {
  const spinner = ora(`Fetching ${batchSize} emails from inbox...`).start();
  
  try {
    const response = await gmail.users.messages.list({
      userId: 'me',
      labelIds: ['INBOX'], // Only get emails currently in inbox
      maxResults: batchSize,
      pageToken: pageToken
    });

    spinner.succeed(`Fetched ${response.data.messages?.length || 0} emails from inbox`);
    
    return {
      messages: response.data.messages || [],
      nextPageToken: response.data.nextPageToken
    };
  } catch (error) {
    spinner.fail('Failed to fetch emails');
    throw error;
  }
}

async function processBatch(auth, config, batchNumber) {
  const gmail = google.gmail({ version: 'v1', auth });
  const analyzer = new EmailAnalyzer(auth, config.vipEmails, config.protectedSenders, config.protectedKeywords);
  
  // Get emails from inbox only
  const { messages, nextPageToken } = await fetchInboxEmails(gmail, 500);
  
  if (messages.length === 0) {
    console.log(chalk.yellow('No more emails in inbox to process!'));
    return { processed: 0, hasMore: false, nextPageToken: null };
  }

  console.log(chalk.cyan(`🔍 Analyzing ${messages.length} emails from batch ${batchNumber}...`));
  const analysisResults = await analyzer.analyzeAllEmails(messages);
  
  analyzer.displaySummary();
  await analyzer.saveAnalysisResults();

  // Show what would be archived
  const toArchive = 
    analysisResults.newsletters.length + 
    analysisResults.promotional.length + 
    analysisResults.automated.length;
    
  console.log(chalk.bold.yellow(`\n⚠️  This will archive ${toArchive} emails and remove them from inbox!`));
  console.log(chalk.gray('(They will still be searchable in Gmail)'));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const proceed = await rl.question('\n' + chalk.yellow('Apply filtering rules to this batch? (y/n): '));
  
  if (proceed.toLowerCase() === 'y') {
    const filter = new EmailFilter(auth);
    
    console.log(chalk.cyan('\n🏷️  Setting up labels...'));
    const labels = await filter.setupFilteringLabels();
    
    console.log(chalk.cyan('⚡ Applying filters...'));
    await filter.applyFiltersToExisting(analysisResults, labels);
    
    filter.displayFilteringSummary(analysisResults);
    console.log(chalk.green('\n✅ Batch filtering complete!'));
  }
  
  rl.close();
  return { 
    processed: messages.length, 
    hasMore: !!nextPageToken,
    nextPageToken: nextPageToken 
  };
}

async function main() {
  console.log(chalk.bold.cyan('\n🚀 Gmail Inbox Batch Processor\n'));
  console.log(chalk.yellow('This will process emails currently in your inbox in batches.'));
  console.log(chalk.yellow('Previously archived emails will NOT be re-processed.\n'));

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const config = await getConfig();
    console.log(chalk.green(`✅ ${config.vipEmails.length} VIP emails configured`));
    console.log(chalk.green(`✅ ${config.protectedSenders.length} protected senders configured`));
    console.log(chalk.green(`✅ ${config.protectedKeywords.length} protected keywords configured\n`));

    let batchNumber = 1;
    let totalProcessed = 0;
    let hasMore = true;
    let pageToken = null;
    
    while (hasMore) {
      console.log(chalk.bold.cyan(`\n📦 Processing batch ${batchNumber}...`));
      
      const result = await processBatch(auth, config, batchNumber);
      totalProcessed += result.processed;
      hasMore = result.hasMore;
      pageToken = result.nextPageToken;
      
      if (hasMore) {
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        const answer = await rl.question('\n' + chalk.yellow('Process next batch from inbox? (y/n): '));
        rl.close();
        
        if (answer.toLowerCase() !== 'y') {
          break;
        }
      }
      
      batchNumber++;
    }
    
    console.log(chalk.green(`\n✅ All done! Processed ${totalProcessed} emails in ${batchNumber} batches.`));
    
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();