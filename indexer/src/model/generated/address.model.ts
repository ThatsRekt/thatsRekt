import {Entity as Entity_, Column as Column_, PrimaryColumn as PrimaryColumn_, BigIntColumn as BigIntColumn_, IntColumn as IntColumn_, BooleanColumn as BooleanColumn_, OneToMany as OneToMany_, Relation as Relation_} from "@subsquid/typeorm-store"
import {PostAttacker} from "./postAttacker.model"
import {PostVictim} from "./postVictim.model"

@Entity_()
export class Address {
    constructor(props?: Partial<Address>) {
        Object.assign(this, props)
    }

    /**
     * the address (lowercased)
     */
    @PrimaryColumn_()
    id!: string

    /**
     * signed sum of net confirmations across all non-removed posts listing the address as attacker
     */
    @BigIntColumn_({nullable: false})
    attackerScore!: bigint

    /**
     * count of posts where the address is listed as attacker (lifetime, includes removed)
     */
    @IntColumn_({nullable: false})
    attackerAppearances!: number

    /**
     * true iff the address is listed as victim of at least one non-removed post (== victimActivePostCount > 0)
     */
    @BooleanColumn_({nullable: false})
    isVictim!: boolean

    /**
     * count of non-removed posts where the address is listed as victim — mirrors contract's _victimActivePosts mapping
     */
    @IntColumn_({nullable: false})
    victimActivePostCount!: number

    @OneToMany_(() => PostAttacker, e => e.address)
    attackerLinks!: Relation_<PostAttacker[]>

    @OneToMany_(() => PostVictim, e => e.address)
    victimLinks!: Relation_<PostVictim[]>
}
