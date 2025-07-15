import { authorize } from './auth.js';
import { EmailAnalyzer } from './emailAnalyzer.js';
import { EmailFilter } from './emailFilter.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config();

async function checkCredentials() {
  const credentialsPath = path.join(__dirname, '../credentials.json');
  try {
    await fs.access(credentialsPath);
    return true;
  } catch {
    return false;
  }
}

async function getVIPEmails() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const envVIPs = process.env.VIP_EMAILS ? process.env.VIP_EMAILS.split(',') : [];
  
  if (envVIPs.length > 0) {
    console.log(chalk.cyan('\nVIP emails from .env file:'));
    envVIPs.forEach(email => console.log(`  - ${email.trim()}`));
    
    const useEnv = await rl.question('\nUse these VIP emails? (y/n): ');
    if (useEnv.toLowerCase() === 'y') {
      rl.close();
      return envVIPs;
    }
  }

  console.log(chalk.cyan('\nEnter VIP email addresses (comma-separated):'));
  const vipInput = await rl.question('VIP emails: ');
  rl.close();
  
  return vipInput.split(',').map(email => email.trim()).filter(email => email);
}

async function main() {
  console.log(chalk.bold.cyan('\n🚀 Gmail Email Filter & Analyzer\n'));

  if (!await checkCredentials()) {
    console.log(chalk.red('❌ credentials.json not found!'));
    console.log(chalk.yellow('\nTo set up Gmail API:'));
    console.log('1. Go to https://console.cloud.google.com/');
    console.log('2. Create a new project or select existing');
    console.log('3. Enable Gmail API');
    console.log('4. Create credentials (OAuth 2.0 Client ID)');
    console.log('5. Download credentials as credentials.json');
    console.log('6. Place credentials.json in the project root');
    return;
  }

  try {
    console.log(chalk.cyan('🔐 Authenticating with Gmail...'));
    const auth = await authorize();
    console.log(chalk.green('✅ Authentication successful!\n'));

    const vipEmails = await getVIPEmails();
    console.log(chalk.green(`\n✅ ${vipEmails.length} VIP emails configured\n`));

    // Get protected senders and keywords from environment
    const protectedSenders = process.env.PROTECTED_SENDERS ? process.env.PROTECTED_SENDERS.split(',').map(e => e.trim()) : [];
    const protectedKeywords = process.env.PROTECTED_KEYWORDS ? process.env.PROTECTED_KEYWORDS.split(',').map(k => k.trim()) : [];
    
    console.log(chalk.green(`✅ ${protectedSenders.length} protected senders configured`));
    console.log(chalk.green(`✅ ${protectedKeywords.length} protected keywords configured\n`));

    const analyzer = new EmailAnalyzer(auth, vipEmails, protectedSenders, protectedKeywords);
    
    console.log(chalk.cyan('📧 Fetching recent emails...'));
    const messages = await analyzer.fetchEmails(500);
    
    console.log(chalk.cyan('🔍 Analyzing email patterns...'));
    const analysisResults = await analyzer.analyzeAllEmails(messages);
    
    analyzer.displaySummary();
    await analyzer.saveAnalysisResults();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const proceed = await rl.question('\n' + chalk.yellow('Apply filtering rules? (y/n): '));
    
    if (proceed.toLowerCase() === 'y') {
      const filter = new EmailFilter(auth, protectedSenders);
      
      console.log(chalk.cyan('\n🏷️  Setting up labels...'));
      const labels = await filter.setupFilteringLabels();
      
      console.log(chalk.cyan('⚡ Applying filters...'));
      await filter.applyFiltersToExisting(analysisResults, labels);
      
      console.log(chalk.cyan('📝 Creating filter rules...'));
      const filterRules = await filter.createFilters(analysisResults, labels);
      
      filter.displayFilteringSummary(analysisResults);
      
      console.log(chalk.green('\n✅ Email filtering complete!'));
      console.log(chalk.gray('\nYour inbox has been organized with:'));
      console.log('- VIP emails marked and preserved');
      console.log('- Newsletters and promotional emails archived');
      console.log('- Social and forum emails labeled');
      console.log('- Automated emails filtered\n');
    } else {
      console.log(chalk.yellow('\nFiltering cancelled. Analysis results saved.'));
    }
    
    rl.close();
  } catch (error) {
    console.error(chalk.red('\n❌ Error:'), error.message);
    if (error.message.includes('invalid_grant')) {
      console.log(chalk.yellow('\nTry deleting token.json and running again.'));
    }
  }
}

main();