import * as vscode from 'vscode';
import type { ContractSide, ContractSourceType } from '../../shared/contracts';

export function buildVirtualContractUri(
	side: ContractSide,
	sourceType: ContractSourceType,
	index = 0
): vscode.Uri {
	return vscode.Uri.from({ scheme: 'staticverifier', path: `/${side}-${sourceType}-${index}.json` });
}
